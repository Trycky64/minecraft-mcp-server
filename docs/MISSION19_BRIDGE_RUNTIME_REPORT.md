# Mission 19 — Bridge runtime et registres moddés

**État : BLOCKED avant redémarrage contrôlé.** Aucun secret n’a été enregistré dans ce rapport.

## Audit effectué

### Instance Minecraft

- Le seul listener consulté était `127.0.0.1:25665`, PID `23780` (`java.exe`), démarré le 20/10/2026 à 20:01:46.
- Son journal de démarrage est celui du profil `C:\Users\qperr\minecraft-mcp-test\neoforge-processia` : il indique les deux JAR (`processia-0.1.0.jar`, `minecraft_mcp_bridge-0.1.0.jar`), Minecraft `1.21.1`, l’écoute `127.0.0.1:25665`, puis `Done`.
- `server.properties` indique `level-name=world`, `gamemode=survival`, `server-ip=127.0.0.1`, `server-port=25665`, `enable-rcon=false`. `world/level.dat` existe (1 668 octets, dernière écriture observée 20/10/2026 23:20:06).
- Le même journal indique que les deux bridges étaient désactivés par défaut au démarrage.
- Le processus est orphelin (PID parent `25912` absent). L’attachement console tenté depuis cette session a échoué (erreur Win32 203). RCON étant désactivé, aucun canal d’arrêt gracieux vérifié n’est disponible ici.
- Par conséquent, le serveur n’a pas été arrêté, le monde actif n’a pas été copié, et aucune configuration du profil n’a été modifiée. Une copie faite pendant que le serveur tourne ne serait pas présentée comme une sauvegarde cohérente. Aucun processus n’a été terminé.

### Bridges — contrats constatés dans le code

Les deux implémentations sont distinctes et activées seulement explicitement. Elles utilisent des serveurs HTTP séparés, liés à `127.0.0.1`; aucune n’écoute sur l’interface publique. Leurs ports par défaut sont différents (`25577` pour le bridge générique, `25576` pour Processia) et chaque bridge refuse le port Minecraft comme port de bridge.

**Bridge NeoForge générique** (`neoforge-bridge/`) :

- Activation : `MINECRAFT_MCP_BRIDGE_ENABLED=true` et `MINECRAFT_MCP_ENVIRONMENT=development`.
- Endpoint Minecraft attendu : `MINECRAFT_MCP_SERVER_ENDPOINT=127.0.0.1:25665`.
- Port optionnel : `MINECRAFT_MCP_BRIDGE_PORT`; URL MCP optionnelle : `MINECRAFT_MCP_BRIDGE_URL`.
- Le secret est fourni par `MINECRAFT_MCP_BRIDGE_SECRET` ou généré aléatoirement au démarrage. Les identifiants (secret, identité serveur, endpoint et version NeoForge) sont écrits dans `MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE`, par défaut `config/minecraft-mcp-bridge.credentials.json`, avec ACL Windows vérifiée limitée au propriétaire. Le bridge bind sur loopback.
- Le MCP sélectionne ce mode avec `MINECRAFT_MCP_BRIDGE_ENABLED=true`, lit le fichier configuré par `MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE`, puis réalise le handshake et valide protocole, endpoint, identité, versions et epoch.

**Bridge Processia** (`src/main/java/.../bridge/`) :

- Activation : `PROCESSIA_BRIDGE_ENABLED=true` et `PROCESSIA_ENVIRONMENT=development`.
- Variables requises : `PROCESSIA_BRIDGE_SECRET` (au moins 32 caractères), `PROCESSIA_BRIDGE_SERVER_IDENTITY`, `PROCESSIA_MINECRAFT_ENDPOINT=127.0.0.1:25665`; port optionnel `PROCESSIA_BRIDGE_PORT` (défaut `25576`).
- Il bind également sur loopback, authentifie le bearer puis émet des sessions, et réinitialise son epoch à chaque démarrage. Aucun secret n’est codé en dur.
- Côté MCP, ce mode est utilisé si le mode générique n’est pas activé. Le code donne priorité au mode générique lorsque les deux indicateurs MCP sont actifs : un seul mode de client bridge est sélectionné par processus MCP. Les deux serveurs Java pourraient coexister sur leurs ports distincts, mais cette combinaison n’a pas été activée ni testée.

Les deux bridges ne partagent ni port, ni format de credentials, ni en-têtes de session. Il ne faut pas réutiliser le secret générique comme secret Processia sans décision explicite. Aucun secret runtime n’a été lu ni affiché pendant cet audit.

## Résultats runtime de cette reprise

| Vérification | Résultat | Preuve / limite |
|---|---|---|
| Cible isolée et port Minecraft | PASS | Listener `127.0.0.1:25665` PID 23780 et journal de démarrage du profil isolé. Aucun paquet de jeu n’a été envoyé par cette mission. |
| Version/mods | PASS | Journal : Minecraft 1.21.1; JAR Processia 0.1.0 et bridge générique détectés. NeoForge 21.1.259 reste à vérifier au prochain démarrage/handshake. |
| Bridges avant reprise | PASS | Journal : les deux désactivés par défaut. |
| Arrêt propre / sauvegarde cohérente | BLOCKED | RCON désactivé, parent du processus absent, console non attachable depuis cette session. Aucun arrêt forcé et aucune copie en ligne. |
| Handshake / credentials / epoch | NOT RUN | Impossible d’activer les variables de démarrage sans redémarrage sûr. |
| Registres Processia, ID 1373 | NOT RUN | Aucun mapping runtime autoritatif consulté ; ID 1373 reste non résolu et intact. |
| `declare_recipes` PartialReadError | NOT REPRODUCED | Aucun bot MCP connecté durant cette reprise ; aucune hypothèse de correctif protocolaire n’est avancée. |
| Changement de `registryEpoch` de Mission 18 | UNRESOLVED | Aucun journal de session corrélable ni handshake de bridge disponible pour attribuer la cause. |
| Recherche / interaction machine Processia | NOT RUN | Aucune recherche ni action n’a été envoyée au serveur. |
| Port personnel 25565 | NOT ACCESSED | Aucun test ni connexion vers ce port. |

## État des dépôts

Aucun fichier source, configuration serveur, dépendance ou lockfile n’a été modifié. Les deux working trees contenaient déjà de nombreuses modifications locales non commitées avant cette mission; elles ont été laissées intactes. Ce rapport est la seule addition de cette reprise dans le dépôt MCP. Aucun commit, push, tag, PNG ou changement de version.

Les builds, tests et lint n’ont pas été relancés : aucune source n’a été modifiée, et la validation runtime est bloquée avant activation du bridge.

## Reprise sûre requise

Pour continuer sans forcer l’arrêt :

1. Rendre accessible la console de cette instance ou démarrer le même profil depuis un superviseur conservant son entrée standard; envoyer `stop` à cette instance uniquement et attendre sa sortie normale.
2. Confirmer que le PID a quitté et que `25665` n’écoute plus.
3. Copier `world` vers un nouveau dossier unique sous `C:\Users\qperr\minecraft-mcp-test`, puis vérifier `level.dat`, les régions, les dimensions, le nombre et la taille des fichiers. Ne jamais écraser une sauvegarde existante.
4. Préparer un lancement du même profil et du même monde avec des environnements de développement limités au processus. Activer le bridge générique pour la découverte complète; utiliser ensuite le client Processia dédié si ses diagnostics spécifiques sont nécessaires. Garder les deux bindings loopback et leurs ports séparés.
5. Démarrer depuis la console/superviseur contrôlé; lire les credentials sans les imprimer, lancer exclusivement le fork MCP local sur `127.0.0.1:25665`, faire le handshake, puis interroger les registres et seulement après rechercher une machine chargée.

**Verdict Mission 19 : BLOCKED**, car le critère principal (bridge authentifié et registres runtime disponibles) n’a pas été exécuté. La cause immédiate est l’absence d’un canal d’arrêt gracieux vérifiable pour le serveur déjà actif, alors que la sauvegarde cohérente est un prérequis explicite.

## Complément Mission 19.1 — récupération du serveur

Diagnostic supplémentaire, sans arrêt ni connexion réseau :

- PID `23780` revérifié : `java.exe` Temurin 21, arguments NeoForge `21.1.259` avec fichiers d’arguments relatifs. `netstat` et `Get-NetTCPConnection` associent toujours le listener `127.0.0.1:25665` à ce PID. Les propriétés du profil et le journal de démarrage correspondent au profil isolé et au monde `world`; le script `run.bat` lance les mêmes fichiers d’arguments depuis le répertoire courant. Le répertoire courant du processus n’est pas exposé par les interfaces inspectées, donc cette association repose sur les éléments croisés du profil, du listener et du journal, pas sur une lecture directe du CWD.
- Le parent `25912` reste absent. Le processus est vivant (tasklist : environ 968 Mo de mémoire et 3 min 15 s de CPU) mais aucun canal stdin/console récupérable n’a été établi. L’appel `AttachConsole(23780)` a échoué avec Win32 203.
- `ops.json` ne contient aucun opérateur existant. Le seul outil MCP repéré pour envoyer du texte est un outil de chat Mineflayer ; il ne constitue pas une autorisation administrative et ne sera pas utilisé pour tenter `/save-all` ou `/stop`.
- `enable-rcon=false`, `enable-query=false`; aucun canal de gestion déjà autorisé n’a été trouvé dans les propriétés du serveur ou les scripts du profil. Les bridges de diagnostic sont en lecture seule et désactivés ; ils ne fournissent pas d’arrêt du serveur.
- Les logs signalent un retard de 11 575 ms à 21:44 puis 5 582 619 ms (environ 93 minutes) à 23:18 le 20/10/2026. Cela établit un retard/jump important côté tick, mais pas sa cause. Aucun diagnostic ne permet de conclure à un deadlock ni à une corruption.
- `run.bat` utilise les arguments `@user_jvm_args.txt` et `@libraries/.../win_args.txt`, puis `pause`. Si le script a été lancé depuis un runner détaché, l’hypothèse d’une console/entrée standard perdue est plausible, mais le mécanisme de lancement initial n’est pas prouvé.

La Phase 2 de la Mission 19.1 est donc bloquée après examen des voies A à D : aucune console/supervision récupérable, RCON désactivé, aucun compte opérateur déjà autorisé, et aucun autre mécanisme d’arrêt documenté disponible. Le serveur est toujours actif. Aucun fichier du monde n’a été copié ou modifié. La mission s’arrête ici conformément à la règle de ne pas forcer l’arrêt ; il faut que l’utilisateur rende la console accessible ou demande explicitement une autre procédure contrôlée.
