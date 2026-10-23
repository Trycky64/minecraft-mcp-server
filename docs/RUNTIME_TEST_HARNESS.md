# Mission 29 — banc de validation runtime multi-mods

## Périmètre et sécurité

Ce banc est distinct des anciens profils de test. Il ne réutilise aucun dossier `vanilla`, `neoforge-generic`, `neoforge-processia` ou `neoforge-third-party` existant, ni aucun monde historique. Chaque exécution autorisée doit être copiée depuis un template sans monde dans un répertoire UUID neuf sous une racine Mission 29 séparée. Le script ne supprime ni ne remplace les exécutions antérieures.

Aucun serveur n'a été démarré pour préparer ce banc. Les ports Minecraft, bridge et GUI n'ont pas de valeur par défaut et aucun port de remplacement n'est approuvé par ce document. Le lanceur exige `-AuthorizeStart`, une cible explicite en loopback, un port Minecraft explicite, un port bridge distinct pour NeoForge, un template propre, une acceptation EULA déjà présente dans ce template et un manifeste vérifié. Il refuse `25565` (serveur personnel), `25665` (ancien serveur de test historique), les ports déjà en écoute, les chemins du dépôt, les templates contenant un monde, les propriétés serveur copiées, les credentials et les fichiers secrets.

Le lanceur fixe `server-ip=127.0.0.1`, désactive RCON, query et command blocks, utilise un monde neuf nommé `world`, un mode Survie, et ne donne aucun privilège opérateur. Le mode `online-mode=false` est limité au serveur jetable lié à loopback. Le bridge générique est activé seulement dans l'environnement du processus NeoForge, reçoit son port et son endpoint explicites et génère ses propres credentials éphémères. Le secret n'est ni fourni par le script ni écrit dans les logs; le chemin du credential est dans le dossier privé du run. Les variables du bridge historique Processia sont retirées de l'environnement enfant puis restaurées dans le processus PowerShell parent.

Le script supervise stdin/stdout/stderr. Le contrôle exact du PID, de l'heure de démarrage, de l'image et de la ligne de commande précède l'envoi de `stop:<runId>` au pipe local. La réponse `accepted` ne confirme pas l'arrêt; le lease et la fermeture du listener sont vérifiés séparément. Le pipe utilise une DACL de SID courant via `PipeSecurity`/`PipeAccessRule`, compatibles Windows PowerShell 5.1/.NET Framework. Aucun `taskkill` ni arrêt forcé n'est utilisé. Un port ne constitue jamais à lui seul une preuve de propriété d'un processus.

## Profils

| Profil | Contenu | Rôle |
|---|---|---|
| `vanilla` | Minecraft 1.21.1 sans mods | Baseline du protocole et menus vanilla. |
| `neoforge-third-party` | NeoForge 21.1.259, bridge générique, un mod tiers possédant un menu non vanilla | Compatibilité générique indépendante de Processia. Le mod n'est pas encore choisi/approuvé. |
| `processia-optional` | NeoForge 21.1.259, bridge générique et Processia | Extension de test spécialisée facultative. Ne conditionne jamais le résultat vanilla ou tiers. |

### Template et manifeste

Les templates doivent être préparés séparément sous `mission29-harness/templates/<profile>`. Ne pas copier de profil antérieur. Ils contiennent uniquement les binaires modpack nécessaires, un `eula.txt` accepté explicitement et `harness-template.json`; ils ne contiennent ni `server.properties`, ni monde, joueur, logs, credentials, `.env` ou sauvegarde.

Manifeste NeoForge (schéma résumé) :

```json
{
  "schemaVersion": 1,
  "profile": "neoforge-third-party",
  "minecraftVersion": "1.21.1",
  "neoForgeVersion": "21.1.259",
  "files": [
    { "path": "eula.txt", "sha256": "<sha256>" },
    { "path": "run.bat", "sha256": "<sha256>" },
    { "path": "mods/bridge.jar", "sha256": "<sha256>" },
    { "path": "mods/approved-mod.jar", "sha256": "<sha256>" }
  ],
  "mods": [
    { "id": "minecraft_mcp_bridge", "file": "bridge.jar", "sha256": "…" },
    { "id": "example_menu_mod", "file": "approved-mod.jar", "sha256": "…" }
  ],
  "thirdParty": {
    "modId": "example_menu_mod", "version": "…", "source": "…",
    "licenseReviewed": true, "approved": true, "approvedBy": "user"
  }
}
```

Extrait abrégé : un vrai manifeste doit énumérer **tous** les fichiers du template (y compris les bibliothèques et fichiers d'arguments NeoForge), chacun avec son SHA-256, puis être approuvé par un digest externe fourni à `-ApprovedManifestSha256`. Les valeurs d'exemple ne désignent aucun mod approuvé. Le profil tiers reste `BLOCKED` jusqu'à l'approbation préalable du mod, de sa licence et de sa compatibilité. Aucun téléchargement ou installation n'a été effectué pendant Mission 29.

## Supervision future

Le lanceur exige `-ApprovedManifestSha256`, digest approuvé indépendamment du manifeste stocké avec le template. Le manifeste déclare le SHA-256 de chaque fichier; tout fichier non déclaré, chemin traversant, point de reparse, JAR non déclaré ou manifeste modifié est refusé. Le profil vanilla refuse tout dossier `mods`. Les nouvelles exécutions sont des dossiers UUID; les collisions sont refusées.

Le lancement vanilla utilise directement `java.exe -jar`, sans valeur de port par défaut. Les ports sont vérifiés dans la table locale des sockets; le lanceur n'effectue aucun ping, handshake, connexion TCP ou requête HTTP. Le processus est identifié par PID, heure de démarrage, image et ligne de commande, qui doit référencer le dossier d'exécution. Les variables d'environnement dont le nom indique un secret, token, mot de passe, credential, clé API ou autorisation sont retirées de l'environnement transmis au processus enfant, puis restaurées dans le superviseur même si le démarrage échoue.

`accepted` sur le pipe signifie seulement « demande reçue ». `Stop-TestProfile.ps1` n'annonce l'arrêt confirmé qu'après disparition de l'identité du processus, état de lease `stopped-confirmed` et fermeture du listener loopback. Les lectures de pipe ont un délai, les clients abandonnés sont refusés, le nom est propre au run, et la DACL Windows est limitée au SID courant.

**NeoForge est bloqué par le lanceur.** `run.bat` est appelé par `cmd.exe`; la transmission de stdin à Java et la durée de vie de Java après la sortie de `cmd.exe` ne sont pas garanties par une preuve. Le script refuse les profils moddés avant de copier le template ou de créer le monde. Leur activation exige un résolveur vérifié d'arguments Java ou un superviseur d'enfants robuste. Aucun démarrage NeoForge n'a été tenté.

## Données de preuve

Un rapport de scénario ne conserve que : versions, liste de mods si publiquement disponible, identité serveur autoritative, identifiants opaques de session/epochs, type numérique du menu, clé namespacée uniquement si autoritative, état de construction Mineflayer, statut raw-only, nombre de slots, complétude, `stateId`, nombres/types de propriétés synchronisées et codes d'erreur assainis. Il n'enregistre ni paquet brut, ni chat, ni secret, ni contenu arbitraire de composant.

Les statuts autorisés sont `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN` et `UNSUPPORTED`. La valeur initiale de chaque scénario est `NOT_RUN`. Une observation raw-only ne prouve ni l'ouverture d'un objet fenêtre Mineflayer, ni le fonctionnement d'un clic. Les scénarios précis sont dans [MULTIMOD_VALIDATION_MATRIX.md](MULTIMOD_VALIDATION_MATRIX.md).

## Démarrage d'une future validation

Avant un lancement vanilla ultérieur : préparer un template sans monde ni secrets, accepter explicitement l'EULA, calculer puis approuver hors du template le hash du manifeste, autoriser un port explicite et vérifier sa disponibilité via la table locale. Aucun profil NeoForge n'est activable par ce script dans son état actuel. Un seul profil à la fois; aucun monde historique n'est supprimé ou copié.

### Mission 29.0 — audit du superviseur Windows

`tools/runtime-harness/Test-SupervisorOffline.ps1` lance uniquement des processus PowerShell factices et des listeners loopback sur des ports éphémères. Il ne lance ni Java, ni Minecraft, ni bridge, ne connaît aucun port Minecraft configuré et ne modifie aucun monde. Ses 60 assertions comprennent un arrêt gracieux différé, une commande ignorée, un enfant vivant après la sortie de son parent, l'identité stricte, des listeners éphémères, les refus du pipe, son timeout et sa DACL effective relue depuis le handle noyau, les manifestes, les chemins, les pompes stdout/stderr réelles, la restauration d'environnement et l'exécution du vrai `Stop-TestProfile.ps1` contre un lease/processus factice. Le vrai lanceur `Start-TestProfile.ps1` est invoqué seulement avec l'autorisation fausse, refusée avant toute préparation.
