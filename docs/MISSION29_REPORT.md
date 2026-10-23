# Rapport Mission 29 — préparation du banc multi-mods

Date d'exécution : 2026-10-21. Mission de préparation hors ligne uniquement.

## Verdict

**PARTIAL — préparation hors ligne réussie; runtime non exécuté.** Le code de politique, les profils, scénarios, scripts de supervision et documents de preuve sont préparés. Aucun serveur ou bridge n'a été démarré, aucun client MCP n'a été lancé, aucun paquet Minecraft n'a été envoyé. Les profils A/B/C sont tous `NOT_RUN`; le choix et l'approbation du mod tiers reste `BLOCKED`.

## État Git

- Branche : `feature/processia-integration`.
- HEAD avant/après : `8c50ee564c8a0983a07187e8d98ba723dee61c3b`.
- L'arbre était déjà fortement modifié avant Mission 29 : `git diff --stat` recensait 47 fichiers suivis modifiés; beaucoup de nouveaux rapports, services et tests existaient déjà. `todo.txt` est présent mais ignoré.
- Mission 29 a ajouté uniquement les fichiers listés ci-dessous. Aucun fichier déjà modifié n'a été restauré ou remplacé. `package.json`, lockfile, `.gitignore`, configuration MCP personnelle et dépôt Processia n'ont pas été modifiés.
- Aucun commit, push, tag ou changement de version.

## Infrastructure et audit

- Les rapports historiques décrivent d'anciens profils sous `C:\Users\qperr\minecraft-mcp-test`; ce répertoire contient de nombreux mondes/run historiques. Ils ne sont pas réutilisés par le banc Mission 29.
- Inventaire OS en lecture seule des seules plages de test déjà documentées : un listener sur `127.0.0.1:25665`, PID `23780`, processus `java`, démarré le 2026-10-20 à 20:01:46. Les ports `25677` et `25678` n'apparaissaient pas en écoute lors de cette lecture. Le PID avait été associé à l'instance historique dans des rapports antérieurs, mais cette mission n'a pas revérifié son chemin/monde et ne l'adopte donc pas comme preuve d'identité. Cette inspection de la table locale des sockets n'a établi aucune connexion réseau. Le processus n'a pas été contacté, arrêté ou modifié.
- La nouvelle racine dédiée prévue est `C:\Users\qperr\minecraft-mcp-test\mission29-harness`, mais elle n'a pas été créée. Aucun template, monde ou EULA n'a été créé/copé.
- Ports : aucun port Mission 29 n'est approuvé ou codé par défaut. Les scripts exigent des ports explicites et refusent `25565`; ils interrogent les sockets locales pour refuser un port occupé, sans se connecter.
- L'API actuelle du bridge générique a été vérifiée en lecture seule dans sa documentation/source : activation explicite `MINECRAFT_MCP_BRIDGE_ENABLED=true`, environnement `development`, port explicite, endpoint Minecraft, credential file; le secret est généré si `MINECRAFT_MCP_BRIDGE_SECRET` est absent, et l'écoute est loopback. Le lanceur retire toute valeur héritée de secret et de l'adaptateur Processia avant de lancer NeoForge, puis restaure l'environnement parent. Aucun secret n'a été lu ni généré.
- Les mécanismes historiques de démarrage n'ont pas été lancés ni réutilisés. Aucun processus n'a été arrêté.

## Modifications Mission 29

- `src/runtime-harness/runtime-harness-policy.ts` : profils et scénarios, garde-fous purs sur hôte/ports/autorisation/répertoires, comparaison stricte d'identité PID+heure+exécutable+cwd+runId, supervision testable avec adaptateur de processus injecté, statut initial `NOT_RUN`.
- `tests/runtime-harness-policy.test.ts` : huit tests AVA hors ligne, dont profils, boucle locale, refus du port interdit, cible implicite, ports conflictuels, chemins, identité, démarrage non autorisé, un seul profil actif, arrêt gracieux, timeout sans kill et `NOT_RUN`.
- `tools/runtime-harness/Start-TestProfile.ps1` : après l'audit Mission 29.0, exige aussi un hash de manifeste approuvé indépendamment, inventorie et hashe tous les fichiers du template, et refuse les profils NeoForge tant que le contrôle de `cmd.exe`/Java n'est pas démontré.
- `tools/runtime-harness/Stop-TestProfile.ps1` : lease v2; compare PID, heure, image, ligne de commande et run path, puis exige l'état final explicite et le port loopback fermé avant d'annoncer l'arrêt; aucun kill forcé ou suppression de monde.
- `docs/RUNTIME_TEST_HARNESS.md` : architecture, sécurité, exigences des templates et procédures futures.
- `docs/MULTIMOD_VALIDATION_MATRIX.md` : profils, critères, schéma de preuve et statuts initiaux.

### Choix du mod tiers

Aucun mod n'est choisi. Il faut sélectionner et vérifier avant téléchargement/installation sa compatibilité Minecraft 1.21.1 et NeoForge 21.1.259, son menu non vanilla, sa provenance, son SHA-256 et sa licence, puis enregistrer l'approbation humaine dans le manifeste. Les profils A et B ne dépendent pas de Processia; C est facultatif.

## Validation

- `npm run build` : **PASS**.
- `npm test` : **PASS, 369 tests** (baseline rapportée 361; 8 nouveaux tests).
- `npm run lint` : **PASS**.
- `git diff --check` : **PASS** (avertissements CRLF historiques seulement).
- Parse statique des scripts avec le parser PowerShell : **PASS** pour `Start-TestProfile.ps1` et `Stop-TestProfile.ps1`. L'API `PipeSecurity`/`PipeAccessRule`/constructeur ACL de `NamedPipeServerStream` a été vérifiée présente dans le .NET Framework local. Le défaut de compatibilité initial avec `PipeOptions.CurrentUserOnly` a été corrigé avant lancement.
- Tests unitaires du superviseur avec processus factice : **PASS**; aucun serveur Minecraft n'est lancé par ces tests.
- Démarrage de serveur et validations EULA/NeoForge/bridge/MCP/menus : **NOT_RUN**. La suite Mission 29.0 a testé le pipe/ACL sur des processus factices, sans lancer Minecraft.

## Matrice synthétique

| Domaine | Statut | Motif |
|---|---|---|
| Profil A — Vanilla | NOT_RUN | Aucun serveur démarré. |
| Profil B — NeoForge tiers | BLOCKED / NOT_RUN | Mod tiers non sélectionné/approuvé; aucun serveur démarré. |
| Profil C — Processia facultatif | NOT_RUN | Aucune instance démarrée; profil non bloquant pour A/B. |
| Supervision simulée hors ligne | PASS | Tests AVA avec fake process. |
| Scripts PowerShell | PARTIAL | Parse statique; le script Stop a été exercé avec un processus factice, aucun démarrage Minecraft. |
| Protection historique | PASS | Le PID 23780 et le monde historique n'ont pas été touchés; port 25565 non consulté. |

## Limites et condition de Mission 29.1


## Mise à jour Mission 29.0 — durcissement et test Windows hors ligne

- Audit initial : branche `feature/processia-integration`, HEAD `8c50ee564c8a0983a07187e8d98ba723dee61c3b`. Le worktree était déjà fortement modifié; aucun état préexistant n'a été restauré ni supprimé.
- Défaut démontré par le code : NeoForge passait par `cmd.exe /c run.bat`; le superviseur et Stop suivaient uniquement le PID racine. La disparition de `cmd.exe` pouvait donc être prise à tort pour une fin de Java. L'acceptation pipe ne signifie pas arrêt terminé.
- Correction fail-closed : `Start-TestProfile.ps1` refuse désormais tout profil NeoForge avant création d'un run. Le profil vanilla direct Java reste disponible sous un lease v2; son arrêt n'est `stopped-confirmed` que lorsque le Java exact est terminé et que le listener loopback a disparu. Aucun script Minecraft n'a été invoqué.
- Identité de processus : PID, heure de démarrage, image et ligne de commande CIM exacts; pour Stop, la ligne de commande doit inclure le dossier du run. Le pipe exige le runId exact, le SID courant, une DACL protégée, un nom propre au run, et un timeout de lecture.
- Fichiers : chemin sous la racine, reparse points refusés, manifest externe lié à un SHA-256 approuvé, liste exhaustive et hashes de fichiers, refus des chemins absolus/`..`, fichiers ou mods supplémentaires. L'environnement enfant filtre les noms de variables sensibles et restaure exactement l'environnement parent après succès ou échec. Les lignes de log sont bornées et assainies.
- `tools/runtime-harness/Test-SupervisorOffline.ps1` : **60/60 assertions PASS**. Processus factices PowerShell réels, commandes d'arrêt différé/ignoré, enfant survivant à son parent, listener sur port éphémère, pipes valides/invalides/abandonnés/bloqués, DACL effective lue du handle noyau, manifeste/chemins/pompes stdout-stderr/environnement, refus du vrai Start sans autorisation, et appel du vrai Stop avec lease factice.
- Parsing PowerShell 5.1 : PASS pour module et scripts. Aucun serveur/bridge/Java/MCP n'a été démarré ou contacté; aucun monde ou configuration MCP n'a été touché. Les deux répertoires temporaires résiduels des essais initiaux en échec ont été vérifiés puis nettoyés fichier par fichier. Le test d'un point de reparse réel par jonction n'a pas été tenté; sa détection est vérifiée par inspection de code, pas par fixture de jonction.

La validation démontre le comportement hors ligne du superviseur sur des processus factices Windows, pas le lancement d'un vrai serveur. `Start-TestProfile.ps1` n'a été invoqué qu'avec l'autorisation désactivée afin de vérifier son refus avant préparation; le chemin de lancement autorisé n'a pas été exercé. Aucun profil vanilla n'a été démarré.

Le profil NeoForge reste refusé avant toute création de run : `run.bat` passe par `cmd.exe`, et le suivi fiable de la JVM enfant/stdin n'est pas établi. La suite ne tente donc ni un démarrage NeoForge, ni un bridge, ni une connexion MCP. Il manque aussi un test réel de point de reparse (jonction), une course de deux requêtes Stop concurrentes et une preuve de démarrage réussi du lanceur. Ces limites ne sont pas couvertes par les 60 assertions.

Pour clore ces limites, il faudra démontrer d'abord sur un fixture isolé la résolution exacte des arguments Java ou un contrôle fiable du groupe de processus, puis exercer Start/Stop vanilla sur un template jetable approuvé. NeoForge ne pourra être activé qu'après démonstration du cycle de vie complet, y compris stdin, JVM enfant, arrêt gracieux, listener et lease final.

Fichiers de durcissement : `tools/runtime-harness/Supervisor.Core.psm1`, `Start-TestProfile.ps1`, `Stop-TestProfile.ps1`, `Test-SupervisorOffline.ps1`, ainsi que `docs/RUNTIME_TEST_HARNESS.md` et le présent rapport. La suite confirme l'ACL effective du pipe sur le handle noyau, mais pas une tentative d'accès depuis un autre SID; l'isolation multi-utilisateur demeure à éprouver dans un environnement Windows dédié.

Verdict Mission 29.0 : **PARTIAL**. Le cycle d'un processus factice et la DACL effective sont démontrés. Le superviseur NeoForge est intentionnellement indisponible jusqu'à résolution vérifiée des arguments directs Java ou d'un mécanisme de job/process tree fiable. Ces tests ne constituent pas une validation Minecraft.
