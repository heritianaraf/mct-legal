# MCT Music Bot — MP3 Google Drive

Bot Discord en Node.js qui lit des MP3 publics depuis Google Drive dans un salon vocal.

## Prérequis
- Node.js 20.11 ou supérieur
- Un bot créé dans le Discord Developer Portal
- Le bot invité sur ton serveur avec les permissions `applications.commands`, `Connect` et `Speak`
- Le fichier Google Drive doit être accessible en lecture à **Toute personne disposant du lien**

## Installation (Windows / PowerShell)
1. Décompresse le dossier.
2. Ouvre un terminal dans le dossier `mct-music-bot`.
3. Installe les dépendances :
   ```powershell
   npm install
   ```
4. Copie `.env.example` vers `.env`.
5. Remplis `DISCORD_TOKEN`, `CLIENT_ID` et `GUILD_ID` dans `.env`.
6. Enregistre les commandes Discord :
   ```powershell
   npm run deploy
   ```
7. Démarre le bot :
   ```powershell
   npm start
   ```

## Commandes Discord
- `/play lien:<URL Google Drive>` : télécharge et ajoute le MP3 à la file.
- `/pause` : pause.
- `/resume` : reprend.
- `/stop` : arrête, vide la file et quitte le salon.

## Où trouver les identifiants ?
- `DISCORD_TOKEN` : Discord Developer Portal → ton application → Bot → Reset Token / Copy.
- `CLIENT_ID` : General Information → Application ID.
- `GUILD_ID` : active le mode développeur dans Discord, clic droit sur le serveur → Copier l'identifiant.

Ne partage jamais le token du bot et ne l'envoie jamais dans un salon Discord.

## Limites et dépannage
- Cette première version accepte les liens Google Drive publics et limite les fichiers à 100 Mo.
- Google peut bloquer certains téléchargements (notamment les fichiers très téléchargés ou protégés par une page de confirmation). Dans ce cas, le bot affiche une erreur : il faudra utiliser un lien de téléchargement réellement accessible ou ajouter une intégration Google Drive authentifiée.
- Le bot doit rester lancé sur un ordinateur ou un hébergement compatible pour rester connecté.
- Si le bot ne rejoint pas le vocal, vérifie les permissions `Connect` et `Speak`, ainsi que l'accès du bot au salon.
- Si `npm install` échoue avec `EACCES`, ferme les terminaux/éditeurs qui verrouillent le dossier, vérifie les droits Windows et réessaie dans PowerShell.
