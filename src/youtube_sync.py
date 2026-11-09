"""
youtube_sync.py : pont Python <-> MCT MUSIC
===========================================
Ce que fait l'outil (sans Excel) :
  1. lit youtube.json dans le salon de sauvegarde Discord (BACKUP_CHANNEL_ID),
     c'est la liste des liens ajoutés depuis le dashboard MCT MUSIC ;
  2. télécharge en MP3 (yt-dlp + ffmpeg, 192 kbit/s) les liens dont le MP3
     n'est pas encore dans le salon ;
  3. poste chaque MP3 dans le même salon, au format attendu par le bot
     ("🎵 MP3 yt-<id>.mp3"), pour que MCT MUSIC le retrouve et le lise.

Il utilise le MÊME token que le bot (DISCORD_TOKEN) : le bot ne lit que les
messages postés par lui-même.

Installation :
    pip install yt-dlp requests
    ffmpeg doit être installé et dans le PATH (ou FFMPEG_LOCATION dans .env)

Utilisation :
    python youtube_sync.py            -> interface graphique
    python youtube_sync.py --once     -> une synchronisation, sans fenêtre
    python youtube_sync.py --watch 10 -> synchronisation toutes les 10 minutes
    (+ --delete-after : supprime la copie locale après envoi)

Configuration : variables d'environnement ou fichier .env (dossier courant,
dossier du script ou dossier parent, donc celui du bot) :
    DISCORD_TOKEN, BACKUP_CHANNEL_ID
    optionnel : YOUTUBE_COOKIES_FILE, YOUTUBE_COOKIES_BROWSER (ex. chrome),
                FFMPEG_LOCATION, DISCORD_UPLOAD_LIMIT_MB (10 par défaut)
"""

import argparse
import json
import os
import queue
import shutil
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

API = "https://discord.com/api/v10"
FILE_TAG = "🎵 MP3 "            # identique à FILE_TAG dans index.js
YOUTUBE_JSON = "youtube.json"    # identique à YOUTUBE_BACKUP_NAME dans index.js
MAX_SECONDS = 2 * 3600           # identique à YTDLP_MAX_SECONDS dans index.js
DEFAULT_QUALITY = 192


# --------------------------------------------------------------- configuration
def load_env():
    here = Path(__file__).resolve().parent
    for folder in (Path.cwd(), here, here.parent):
        env_file = folder / ".env"
        if not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:]
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def extract_youtube_id(raw):
    """Même logique que extractYoutubeId() dans index.js."""
    try:
        url = urlparse(str(raw or "").strip())
    except ValueError:
        return None
    host = (url.hostname or "").lower()
    for prefix in ("www.", "m.", "music."):
        if host.startswith(prefix):
            host = host[len(prefix):]
    vid = None
    if host == "youtu.be":
        vid = url.path.split("/")[1] if url.path.count("/") >= 1 else None
    elif host in ("youtube.com", "youtube-nocookie.com"):
        if url.path == "/watch":
            vid = (parse_qs(url.query).get("v") or [None])[0]
        else:
            parts = url.path.split("/")
            if len(parts) > 2 and parts[1] in ("shorts", "embed", "live", "v"):
                vid = parts[2]
    ok = vid and len(vid) == 11 and all(c.isalnum() or c in "-_" for c in vid)
    return vid if ok else None


def youtube_url_for(vid):
    return f"https://www.youtube.com/watch?v={vid}"


def stored_name(vid):
    return f"yt-{vid}.mp3"


# --------------------------------------------------------------------- Discord
class Discord:
    def __init__(self, token, channel_id):
        self.channel_id = str(channel_id)
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Bot {token}"
        self.bot_id = self._request("GET", "/users/@me").json()["id"]

    def _request(self, method, path, **kwargs):
        for _ in range(6):
            r = self.session.request(method, API + path, timeout=90, **kwargs)
            if r.status_code == 429:
                try:
                    wait = float(r.json().get("retry_after", 1))
                except ValueError:
                    wait = 1.0
                time.sleep(wait + 0.2)
                continue
            if not r.ok:
                raise RuntimeError(f"Discord {r.status_code} : {r.text[:200]}")
            return r
        raise RuntimeError("Discord : trop de requêtes (429).")

    def bot_messages(self, max_pages=30):
        """Messages du bot dans le salon, du plus récent au plus ancien."""
        found, before = [], None
        for _ in range(max_pages):
            params = {"limit": 100}
            if before:
                params["before"] = before
            page = self._request("GET", f"/channels/{self.channel_id}/messages", params=params).json()
            if not page:
                break
            found += [m for m in page if m["author"]["id"] == self.bot_id]
            before = page[-1]["id"]
            if len(page) < 100:
                break
        return found

    def read_state(self):
        """Retourne (items de youtube.json, noms de MP3 déjà dans le salon)."""
        items, names, json_found = [], set(), False
        for m in self.bot_messages(60):
            content = m.get("content", "")
            if content.startswith(FILE_TAG):
                names.add(content[len(FILE_TAG):].strip())
            if not json_found:
                att = next((a for a in m.get("attachments", []) if a["filename"] == YOUTUBE_JSON), None)
                if att:
                    json_found = True
                    raw = requests.get(att["url"], timeout=30).json()
                    items = raw if isinstance(raw, list) else raw.get("items", [])
        return normalize_items(items), names

    def upload_mp3(self, stored, path):
        data = Path(path).read_bytes()
        self._request(
            "POST",
            f"/channels/{self.channel_id}/messages",
            data={"payload_json": json.dumps({"content": FILE_TAG + stored})},
            files={"files[0]": (stored, data, "audio/mpeg")},
        )


def normalize_items(raw_items):
    """Accepte {id,url,title,...}, {url} ou un simple lien (comme normalizeYoutubeEntry)."""
    out, seen = [], set()
    for entry in raw_items:
        item = {"url": entry} if isinstance(entry, str) else dict(entry)
        vid = item.get("id") or extract_youtube_id(item.get("url"))
        if not vid or vid in seen:
            continue
        seen.add(vid)
        out.append({"id": vid, "url": youtube_url_for(vid), "title": item.get("title") or ""})
    return out


# ------------------------------------------------------------------ téléchargement
def ffmpeg_exe():
    loc = os.environ.get("FFMPEG_LOCATION", "").strip()
    if loc:
        p = Path(loc)
        return str(p / "ffmpeg") if p.is_dir() else str(p)
    return shutil.which("ffmpeg")


def download_mp3(vid, out_dir, quality, hook=None):
    import yt_dlp

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    opts = {
        "format": "bestaudio/best",
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3",
                            "preferredquality": str(quality)}],
        "outtmpl": str(out_dir / f"yt-{vid}.%(ext)s"),
        "noplaylist": True,
        "match_filter": yt_dlp.utils.match_filter_func(f"!is_live & duration<={MAX_SECONDS}"),
        "progress_hooks": [hook] if hook else [],
        "quiet": True,
        "no_warnings": True,
    }
    if os.environ.get("FFMPEG_LOCATION"):
        opts["ffmpeg_location"] = os.environ["FFMPEG_LOCATION"]
    if os.environ.get("YOUTUBE_COOKIES_FILE"):
        opts["cookiefile"] = os.environ["YOUTUBE_COOKIES_FILE"]
    elif os.environ.get("YOUTUBE_COOKIES_BROWSER"):
        opts["cookiesfrombrowser"] = (os.environ["YOUTUBE_COOKIES_BROWSER"],)

    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(youtube_url_for(vid), download=True)

    target = out_dir / stored_name(vid)
    if not target.exists():
        raise RuntimeError(f"vidéo ignorée (en direct ou de plus de {MAX_SECONDS // 3600} h).")
    return target, (info or {}).get("title", "")


def fit_under_limit(path, quality, limit_bytes):
    """Réencode à un débit plus bas si le MP3 dépasse la limite d'envoi du salon."""
    size = path.stat().st_size
    if size <= limit_bytes:
        return
    kbps = int(quality * limit_bytes * 0.93 / size)
    if kbps < 32:
        raise RuntimeError("MP3 trop long pour la limite d'envoi Discord de ce serveur.")
    ffmpeg = ffmpeg_exe()
    if not ffmpeg:
        raise RuntimeError("ffmpeg introuvable : impossible de réduire le MP3.")
    tmp = path.with_name(path.stem + ".small.mp3")
    subprocess.run([ffmpeg, "-y", "-i", str(path), "-vn", "-b:a", f"{kbps}k", str(tmp)],
                   check=True, capture_output=True)
    tmp.replace(path)


def upload_limit_bytes():
    try:
        mb = float(os.environ.get("DISCORD_UPLOAD_LIMIT_MB", "10"))
    except ValueError:
        mb = 10.0
    return int(mb * 1024 * 1024 * 0.98)


def process_video(dc, vid, out_dir, quality=DEFAULT_QUALITY, hook=None, log=print, keep_local=True):
    """Télécharge (si besoin) puis envoie dans le salon. Retourne le titre."""
    target = Path(out_dir) / stored_name(vid)
    title = ""
    if target.exists():
        log("  MP3 déjà présent en local : envoi seul.")
    else:
        target, title = download_mp3(vid, out_dir, quality, hook)
    fit_under_limit(target, quality, upload_limit_bytes())
    dc.upload_mp3(stored_name(vid), target)
    if not keep_local:
        target.unlink(missing_ok=True)   # utile sur Render : disque limité
    return title


def make_discord():
    load_env()
    token = os.environ.get("DISCORD_TOKEN", "").strip()
    channel = os.environ.get("BACKUP_CHANNEL_ID", "").strip()
    if not token or not channel:
        raise SystemExit("DISCORD_TOKEN et BACKUP_CHANNEL_ID sont requis (variables ou fichier .env).")
    return Discord(token, channel)


def sync_once(out_dir="Output", quality=DEFAULT_QUALITY, extra_urls=(), dc=None, log=print, stop=None, keep_local=True):
    """Synchronisation complète : utilisable depuis le notebook ou la ligne de commande."""
    dc = dc or make_discord()
    items, in_channel = dc.read_state()
    todo = [i for i in items if stored_name(i["id"]) not in in_channel]
    known = {i["id"] for i in items}
    for url in extra_urls:
        vid = extract_youtube_id(url)
        if vid and vid not in known and stored_name(vid) not in in_channel:
            todo.append({"id": vid, "url": youtube_url_for(vid), "title": ""})
            known.add(vid)

    log(f"{len(items)} lien(s) dans youtube.json, {len(todo)} MP3 à envoyer.")
    ok = 0
    for n, item in enumerate(todo, 1):
        if stop and stop.is_set():
            log("Arrêté.")
            break
        log(f"[{n}/{len(todo)}] {item['title'] or item['url']}")
        try:
            title = process_video(dc, item["id"], out_dir, quality, log=log, keep_local=keep_local)
            ok += 1
            log(f"  ✔ envoyé dans le salon{' : ' + title if title else ''}")
        except Exception as e:  # une vidéo en échec ne bloque pas les suivantes
            log(f"  ✖ {e}")
    log(f"Terminé : {ok}/{len(todo)} envoyé(s).")
    return ok


# --------------------------------------------------------------------- interface
def run_gui():
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    load_env()
    token = os.environ.get("DISCORD_TOKEN", "").strip()
    channel = os.environ.get("BACKUP_CHANNEL_ID", "").strip()

    class App(tk.Tk):
        def __init__(self):
            super().__init__()
            self.title("MCT MUSIC : YouTube → MP3 (Discord)")
            self.geometry("860x660")
            self.minsize(720, 540)
            self.q = queue.Queue()
            self.stop_event = threading.Event()
            self.dc = None
            self.busy = False
            self.in_channel = set()
            self.rows = {}      # iid -> {"id", "url", "title", "extra"}
            self.extras = {}    # id -> url : liens ajoutés ici, pas (encore) dans youtube.json
            self.out_var = tk.StringVar(value=os.path.abspath("Output"))
            self.quality_var = tk.StringVar(value=str(DEFAULT_QUALITY))
            self.url_var = tk.StringVar()
            self._build()
            self.after(100, self._poll)
            if not token or not channel:
                self._log("⚠ DISCORD_TOKEN / BACKUP_CHANNEL_ID introuvables (.env).")
            else:
                self.refresh()
            if not ffmpeg_exe():
                self._log("⚠ ffmpeg introuvable dans le PATH : la conversion MP3 échouera.")

        def _build(self):
            pad = {"padx": 10, "pady": 5}
            top = ttk.Frame(self)
            top.pack(fill="x", **pad)
            self.lbl_conn = ttk.Label(top, text="Discord : non connecté")
            self.lbl_conn.pack(side="left")
            ttk.Button(top, text="⟳ Actualiser depuis Discord", command=self.refresh).pack(side="right")

            add = ttk.LabelFrame(self, text="Ajouter un lien (envoi direct du MP3 dans le salon)")
            add.pack(fill="x", **pad)
            entry = ttk.Entry(add, textvariable=self.url_var)
            entry.pack(side="left", fill="x", expand=True, padx=8, pady=8)
            entry.bind("<Return>", lambda e: self.add_url())
            ttk.Button(add, text="Ajouter", command=self.add_url).pack(side="left", padx=4)
            ttk.Button(add, text="Coller", command=self.paste).pack(side="left", padx=(0, 8))

            lst = ttk.LabelFrame(self, text="Liens (youtube.json du salon Discord)")
            lst.pack(fill="both", expand=True, **pad)
            self.tree = ttk.Treeview(lst, columns=("name", "status"), show="headings", height=9)
            self.tree.heading("name", text="Vidéo")
            self.tree.heading("status", text="Statut")
            self.tree.column("name", width=560)
            self.tree.column("status", width=200, anchor="center")
            sb = ttk.Scrollbar(lst, orient="vertical", command=self.tree.yview)
            self.tree.configure(yscrollcommand=sb.set)
            self.tree.pack(side="left", fill="both", expand=True, padx=(8, 0), pady=8)
            sb.pack(side="left", fill="y", pady=8, padx=(0, 8))

            opt = ttk.LabelFrame(self, text="Options")
            opt.pack(fill="x", **pad)
            ttk.Label(opt, text="Copie locale :").grid(row=0, column=0, padx=8, pady=6, sticky="w")
            ttk.Entry(opt, textvariable=self.out_var).grid(row=0, column=1, sticky="ew")
            ttk.Button(opt, text="Parcourir…", command=self.choose).grid(row=0, column=2, padx=8)
            ttk.Label(opt, text="Qualité (kbps) :").grid(row=1, column=0, padx=8, pady=6, sticky="w")
            ttk.Combobox(opt, textvariable=self.quality_var, width=8, state="readonly",
                         values=("128", "192", "256", "320")).grid(row=1, column=1, sticky="w")
            opt.columnconfigure(1, weight=1)

            act = ttk.Frame(self)
            act.pack(fill="x", **pad)
            self.btn_go = ttk.Button(act, text="▶ Télécharger et envoyer les manquants", command=self.start)
            self.btn_go.pack(side="left")
            self.btn_stop = ttk.Button(act, text="■ Arrêter", command=self.stop_event.set, state="disabled")
            self.btn_stop.pack(side="left", padx=8)
            self.bar = ttk.Progressbar(act, mode="determinate", maximum=100)
            self.bar.pack(side="left", fill="x", expand=True, padx=8)

            box = ttk.LabelFrame(self, text="Journal")
            box.pack(fill="both", expand=True, **pad)
            self.logbox = tk.Text(box, height=7, state="disabled", wrap="word")
            self.logbox.pack(fill="both", expand=True, padx=8, pady=8)

        # -- utilitaires
        def _log(self, text):
            self.logbox.configure(state="normal")
            self.logbox.insert("end", text + "\n")
            self.logbox.see("end")
            self.logbox.configure(state="disabled")

        def choose(self):
            folder = filedialog.askdirectory(initialdir=self.out_var.get() or ".")
            if folder:
                self.out_var.set(folder)

        def add_url(self):
            vid = extract_youtube_id(self.url_var.get())
            if not vid:
                messagebox.showerror("Lien invalide", "Colle le lien d'une vidéo YouTube.")
                return
            self.extras[vid] = youtube_url_for(vid)
            self.url_var.set("")
            self._redraw([i for i in self.rows.values() if not i["extra"]])

        def paste(self):
            try:
                text = self.clipboard_get()
            except tk.TclError:
                return
            for line in text.splitlines():
                vid = extract_youtube_id(line)
                if vid:
                    self.extras[vid] = youtube_url_for(vid)
            self._redraw([i for i in self.rows.values() if not i["extra"]])

        def _redraw(self, items):
            self.tree.delete(*self.tree.get_children())
            self.rows = {}
            known = set()
            for item in items:
                known.add(item["id"])
                self._row(item, extra=False)
            for vid, url in self.extras.items():
                if vid not in known:
                    self._row({"id": vid, "url": url, "title": ""}, extra=True)

        def _row(self, item, extra):
            done = stored_name(item["id"]) in self.in_channel
            status = "✔ MP3 dans Discord" if done else ("À envoyer (ajout local)" if extra else "À télécharger")
            self.rows[item["id"]] = {**item, "extra": extra}
            self.tree.insert("", "end", iid=item["id"], values=(item["title"] or item["url"], status))

        # -- Discord
        def refresh(self):
            if self.busy:
                return
            self.busy = True
            self.btn_go.configure(state="disabled")
            threading.Thread(target=self._refresh_worker, daemon=True).start()

        def _refresh_worker(self):
            try:
                if not self.dc:
                    self.dc = Discord(token, channel)
                items, names = self.dc.read_state()
                self.q.put(("state", items, names))
            except Exception as e:
                self.q.put(("log", f"✖ Lecture du salon impossible : {e}"))
                self.q.put(("idle",))

        def start(self):
            if self.busy or not self.dc:
                return
            todo = [r for r in self.rows.values() if stored_name(r["id"]) not in self.in_channel]
            if not todo:
                messagebox.showinfo("Rien à faire", "Tous les MP3 sont déjà dans le salon.")
                return
            self.busy = True
            self.stop_event.clear()
            self.btn_go.configure(state="disabled")
            self.btn_stop.configure(state="normal")
            out, quality = self.out_var.get().strip() or "Output", int(self.quality_var.get())
            threading.Thread(target=self._run, args=(todo, out, quality), daemon=True).start()

        def _run(self, todo, out, quality):
            ok = 0
            for n, row in enumerate(todo, 1):
                if self.stop_event.is_set():
                    break
                vid = row["id"]
                self.q.put(("status", vid, f"Téléchargement ({n}/{len(todo)})"))

                def hook(d, vid=vid):
                    if self.stop_event.is_set():
                        import yt_dlp
                        raise yt_dlp.utils.DownloadCancelled()
                    if d["status"] == "downloading":
                        total = d.get("total_bytes") or d.get("total_bytes_estimate")
                        if total:
                            self.q.put(("bar", d["downloaded_bytes"] / total * 100))
                    elif d["status"] == "finished":
                        self.q.put(("status", vid, "Conversion MP3…"))

                try:
                    title = process_video(self.dc, vid, out, quality, hook, log=lambda t: self.q.put(("log", t)))
                    ok += 1
                    self.in_channel.add(stored_name(vid))
                    self.q.put(("status", vid, "✔ MP3 dans Discord"))
                    self.q.put(("log", f"✔ {title or row['url']}"))
                except Exception as e:
                    self.q.put(("status", vid, "Erreur"))
                    self.q.put(("log", f"✖ {row['url']} : {e}"))
            self.q.put(("log", f"Terminé : {ok}/{len(todo)} envoyé(s)."))
            self.q.put(("idle",))

        def _poll(self):
            try:
                while True:
                    msg = self.q.get_nowait()
                    kind = msg[0]
                    if kind == "log":
                        self._log(msg[1])
                    elif kind == "bar":
                        self.bar["value"] = msg[1]
                    elif kind == "status":
                        if self.tree.exists(msg[1]):
                            self.tree.set(msg[1], "status", msg[2])
                    elif kind == "state":
                        self.in_channel = set(msg[2])
                        self.lbl_conn.configure(text=f"Discord : connecté ({len(msg[1])} lien(s), {len(msg[2])} MP3)")
                        self._redraw(msg[1])
                        self.busy = False
                        self.btn_go.configure(state="normal")
                    elif kind == "idle":
                        self.busy = False
                        self.bar["value"] = 0
                        self.btn_go.configure(state="normal")
                        self.btn_stop.configure(state="disabled")
            except queue.Empty:
                pass
            self.after(100, self._poll)

    App().mainloop()


def main():
    parser = argparse.ArgumentParser(description="YouTube -> MP3 <-> MCT MUSIC (salon Discord)")
    parser.add_argument("--once", action="store_true", help="une synchronisation, sans interface")
    parser.add_argument("--watch", type=float, metavar="MIN", help="synchronise toutes les MIN minutes")
    parser.add_argument("--out", default="Output", help="dossier des MP3 en local (défaut : Output)")
    parser.add_argument("--quality", type=int, default=DEFAULT_QUALITY)
    parser.add_argument("--delete-after", action="store_true", help="supprime la copie locale après envoi (Render)")
    args = parser.parse_args()

    if args.watch:
        dc = make_discord()
        while True:
            try:
                sync_once(args.out, args.quality, dc=dc, keep_local=not args.delete_after)
            except Exception as e:  # réseau / Discord : on réessaie au prochain tour
                print(f"Synchronisation impossible : {e}", flush=True)
            time.sleep(args.watch * 60)
    elif args.once:
        sync_once(args.out, args.quality, keep_local=not args.delete_after)
    else:
        run_gui()


if __name__ == "__main__":
    main()
