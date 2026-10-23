# Mission 11 — E2E final, sécurité et revue bêta

Date : 2026-10-16. Ce rapport décrit uniquement les essais exécutés pendant la Mission 11. Les rapports Mission 8 à 10 restent des archives historiques. Les preuves brutes sont sous `C:/Users/qperr/minecraft-mcp-test/logs/mission11-*` et les captures sous `C:/Users/qperr/minecraft-mcp-test/artifacts/mission11-gui/`.

Versions effectivement contrôlées : Minecraft 1.21.1/protocole 767, NeoForge 21.1.259, Java Temurin 21.0.12.1, Node 26.8.1/npm 11.19.0 sur Windows, Node 22.16.0/npm 10.9.2 sous WSL, Mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, SDK MCP 1.32.1, Processia 0.1.0 et Mekanism 10.7.15.81.

## Décision

**Verdict global : PARTIAL. Verdict de publication : PARTIAL — BETA POSSIBLE WITH EXCLUSIONS.** Le cœur MCP 2.0.4 est candidat à une revue bêta limitée à Windows x64 et Linux x64. Le GUI reste expérimental : son parcours Crusher réel fonctionne, mais le bridge générique n'expose pas la progression, la combustion et le redstone privés de Processia pour une comparaison serveur complète. Le placement Mineflayer validé concerne les blocs vanilla seulement. Six alertes npm modérées subsistent en production. ARM64 natif est non testé. Aucune version bêta, aucun commit, tag, push ou publication n'a été créé.

| Domaine | Résultat Mission 11 | Preuve et limite |
|---|---|---|
| Vanilla MCP / placement adjacent | PASS | Pile `minecraft:stone ×16` observée dans le slot 36; cible `(-313,79,23)` initialement air, puis stone après `place-block`; console serveur `execute if block ... minecraft:stone` → `Test passed`; pile 15 après synchronisation. |
| Placement distant | PASS | Deux cibles distinctes `(-319,80,24)` et `(-310,80,21)`, navigation effective, lecture MCP stone et confirmation indépendante par la console serveur. Pile 15→14→13 après synchronisation. |
| Timeout / absence de placement tardif | PASS pour le scénario testé | Cible `(-320,80,25)` initialement air, `timeoutMs=100` → arrêt du pathfinder et erreur; deux vérifications serveur espacées → toujours air. Les autres annulations ne sont couvertes que par les tests automatisés existants. |
| NeoForge générique sans Processia | PASS | Bridge autonome chargé, 118 registres, `bridge-refresh-registries` et namespaces via MCP stdio, `get-position` refusé avec `bot-required`. |
| Processia / GUI réel | PARTIAL | Crusher et recette réelle validés sur **un seul client graphique**; valeurs privées non comparables avec le bridge générique. |
| Mekanism tiers | PASS | 123 registres; `basic_energy_cube` ID 1206, `basic_fluid_tank` ID 1177, `basic_bin` ID 1120 pour le seul epoch observé. FE `0/1 600 000`, eau `1 000/32 000 mB`, inventaires lus en lecture seule. |
| Mode `auto` | PASS | Profil Mekanism jetable : refus NeoForge du client vanilla, bascule authentifiée vers `bridge-only`, `bridgeAvailable=true`, `playerAvailable=false`, epoch actif et `get-position` refusé avec `bot-required`. Preuve `logs/mission11-auto-valid-name.json`. |
| Sécurité bridge | PASS pour les chemins ciblés | Secret invalide 401, endpoint incorrect 409, requête rejouée 409, session révoquée 401, route absente 404, handshake valide 200. |
| Windows x64 | PASS | Node 26.8.1/npm 11.19.0, Java 21.0.12.1, build/tests/lint et runtime isolé. |
| Linux x64 | PASS pour MCP | Ubuntu 24.04 WSL x86_64, Node portable 22.16.0/npm 10.9.2, `npm ci` normal, build, 231 tests, lint et MCP stdio listant 56 outils. Aucun serveur Minecraft Linux testé. |
| ARM64 natif | BLOCKED | Aucun hôte ARM64 explicitement autorisé ou disponible pour la Mission 11. |

## Modifications

- `src/tools/gui-tools.ts` : la preuve de recette demande maintenant une **augmentation réelle** de sortie par rapport à l'état initial; le runner vérifie aussi le décrément du slot source après transfert. Une pile de sortie préexistante ne déclenche plus un PASS.
- `tests/gui-tools.test.ts` : non-régression couvrant la sortie préexistante, l'augmentation réelle, l'absence de baseline et un item de sortie incompatible.
- `package.json` : liste `files` limitée à `dist` et `docs` pour écarter sources, tests et métadonnées Git de l'archive npm; `README`, `LICENSE` et `package.json` restent inclus automatiquement.
- `Processia/neoforge-bridge/build.gradle` : renseigne `Implementation-Version: 0.1.0` dans le manifeste et ajoute une vérification Gradle du JAR. Avant correction, NeoForge affichait `0.0NONE` malgré le nom de fichier `0.1.0`; un redémarrage **du profil générique jetable uniquement** a confirmé `Minecraft MCP Diagnostic Bridge 0.1.0` puis un nouveau rafraîchissement MCP de 118 registres.
- README et guides INSTALLATION, BRIDGE_ONLY_MODE, RELEASE_READINESS, RELEASE_GUIDE, RELEASE_NOTES_DRAFT : état Mission 11, limites et version effective. Aucun code Java ou lockfile modifié pendant Mission 11.

## GUI E2E, recette et mutations

Le profil jetable `neoforge-processia` a été démarré seul. Le bridge authentifié annonçait Minecraft 1.21.1, NeoForge 21.1.259, serveur `d6806104-bdc4-4526-bd82-c5ce4dc85654`, epoch registre `24b1e31f-887c-4815-a960-885952125e03`. Le Crusher existant se trouvait à `(12,112,-13)`. Un **unique** client graphique a atteint `clientReady=true`, `interactionReady=true`, puis `screenClass=null` dans le monde prêt. Il a ouvert `processia:crusher`/`WorkshopMenu` normalement.

Le premier `gui-run-e2e` sans sortie demandée a renvoyé PARTIAL attendu : identité, menu, interaction et énergie synchronisée PASS; progression, combustion et redstone privés INCONCLUSIVE. Dans le même client, le serveur de test a donné **un** `minecraft:raw_iron` au joueur `P3GuiProbe`; le menu montrait la pile dans le slot joueur 29, une sortie préexistante de 2 `processia:iron_dust` dans le slot machine 1, et un slot entrée 0 vide. Le second `gui-run-e2e` a déplacé exactement une unité du slot 29 vers 0. Les assertions `exact-client-menu-transfer`, `gui-bridge-slot-comparison`, `player-source-decrement`, identité machine et énergie sont PASS. Le bridge a confirmé la sortie **2→3** `processia:iron_dust` pendant le run : `server-recipe-output-delta=PASS`. Le résultat global reste PARTIAL à cause des trois valeurs privées INCONCLUSIVE. Rapport brut : `artifacts/mission11-gui/e2e-crusher-1792156542374-96d97535-fa83-414b-8ed0-74536ea7a954.json`.

Le contrôle `processia:redstone_cycle` a fait passer le mode de 0 à 1; lecture serveur `data get block 12 112 -13 RedstoneMode` → 1. Il a ensuite été remis à 0 et relu côté serveur. Un slot 255, un mauvais menu, un mauvais bloc et une cible hors portée ont renvoyé des erreurs structurées. Les captures PNG réelles du menu ont été vérifiées à **1280×720** (SHA-256 `1ed39e6460fb0ea8d35f361070e12318dcf3631d37fb806eda0228e13487fb89`) et **1600×900** (`3e763090a5e4da715106961e1e38a4af48bfa6f6e812c6c47f1c6d38bc15d363`). Une capture de l'infobulle « Iron Dust » est également conservée. Le client graphique et le serveur ont été arrêtés proprement.

## Placement vanilla

Le serveur vanilla isolé a annoncé Minecraft 1.21.1 / protocole 767. Le bot `M11PlaceBot` a reçu une pile test de 16 pierres par la console **du serveur jetable**; `list-inventory` a vérifié le slot, la quantité et l'ID brut 1. Cet ID brut est une observation de paquet; `minecraft-data` fournit seulement une candidature statique et n'est pas présenté comme un mapping runtime NeoForge. L'équipement, le placement adjacent et deux placements distants ont traversé les outils MCP réels. La console serveur a confirmé séparément les trois blocs stone. La lecture d'inventaire immédiate peut précéder le paquet de mise à jour; la lecture après synchronisation a confirmé chaque décrément. Au timeout de 100 ms, l'erreur a indiqué l'arrêt de la navigation et l'absence de paquet de placement; la cible est restée air lors de deux contrôles indépendants. Preuve : `logs/mission11-vanilla-control.json` et sorties de la console isolée pendant cette mission.

Le mode `auto` a aussi été rejoué sur le profil Mekanism isolé. Le serveur a explicitement refusé le client Mineflayer sans NeoForge; le MCP a basculé vers le bridge authentifié, sans inventer un joueur. Les appels `minecraft-get-server-info`, `bridge-status` et `registry-status` ont confirmé `bridgeAvailable=true`; `get-position` a renvoyé `bot-required`. Ce profil employait encore l'ancien JAR bridge dont le manifeste annonçait `0.0NONE`; le correctif de manifeste a été validé séparément sur le profil NeoForge générique avec le JAR final, sans changement fonctionnel du protocole.

Le placement d'un bloc moddé par un client Mineflayer vanilla sur un serveur NeoForge refusant ce client n'a pas été testé et n'est pas promis. Les cas `inventaire vide`, `cible occupée`, mapping moddé non autoritatif et timeout sont couverts par les tests automatisés; les autres négatifs de placement ne sont pas tous rejoués en conditions réelles.

## Sécurité et dépendances

Le bridge est désactivé par défaut, écoute sur `127.0.0.1`, génère un credential éphémère propriétaire, valide identité/endpoint/epoch et borne les requêtes; l'inspection refuse les chunks non chargés. Ces propriétés ont été revues dans le code et les tests Java. Pendant la Mission 11, le profil générique a confirmé à l'exécution : secret invalide 401, endpoint erroné 409, handshake correct 200, capabilities readOnly, rejeu 409, route absente 404, fermeture puis session révoquée 401. `logs/mission11-bridge-security.json` ne contient aucun secret. Les actions GUI mutantes ont utilisé `TEST_MUTATION` et l'acquittement de ce monde jetable; les requêtes négatives ont été refusées.

`npm audit` initial : **15 alertes** (10 modérées, 5 élevées), dont `npm audit --omit=dev` : **6 modérées**. Les six noms (`mineflayer`, `minecraft-protocol`, `prismarine-auth`, `@azure/msal-node`, `yggdrasil`, `uuid`) désignent la **même chaîne transitive** et une seule advisory directe `GHSA-w5hq-g745-h8pq` / `CVE-2026-41907` sur `uuid`. Versions observées : `uuid@8.3.2` sous MSAL, `uuid@10.0.0` sous yggdrasil. L'advisory concerne `v3()`, `v5()` et `v6()` avec buffer externe et bornes invalides; le code yggdrasil inspecté appelle `uuid.v4()`. Aucun chemin vers les paramètres buffer vulnérables n'a été démontré dans le mode de test hors ligne, mais l'absence de preuve d'atteignabilité n'est pas une preuve d'immunité. Le correctif publié pour uuid est `11.1.1`; les contraintes transitives actuelles ne l'adoptent pas. `npm audit` ne propose que des rétrogradations incompatibles de Minecraft Protocol/Mineflayer. Décision : ne pas forcer un override ou downgrade non validé; garder le risque **ouvert** pour décision explicite avant publication. Le mode bridge-only évite de créer un client Mineflayer. Sources : [advisory GitHub](https://github.com/advisories/GHSA-w5hq-g745-h8pq), rapports npm JSON de cette mission.

Le `npm pack --dry-run --json` a été contrôlé pour l'absence de `.env`, credentials, mondes, logs, JAR et fichiers personnels. Licence MCP présente. Les notices de licence des JAR doivent être revues avant distribution publique; la candidate locale ne vaut pas autorisation de redistribution.

## Validations et plateformes

| Commande | Résultat |
|---|---|
| MCP `npm ci --no-audit --no-fund` (scripts normaux) | PASS, 507 packages sur Windows. |
| MCP `npm run build`, `npm test`, `npm run lint` | PASS; **231/231 tests** sur le code corrigé. |
| Processia `gradlew.bat build test checkSideSeparation --rerun-tasks --no-daemon --max-workers=1` | PASS; **24/24 tests**. |
| Bridge autonome `gradlew.bat -p neoforge-bridge build test --rerun-tasks --no-daemon --max-workers=1` | PASS; **5/5 tests** et `verifyBridgeJarVersion`. |
| Linux x64 `npm ci` normal, build, tests, lint | PASS; **231/231 tests**. Logs `mission11-linux-*`. |
| Linux x64 MCP stdio | PASS; **56 outils** listés et `bridge-only` déconnecté signalé explicitement. |
| `npm audit`, `npm audit --omit=dev` | PARTIAL sécurité; **15/6 alertes initiales et finales**. |
| `git diff --check` des deux dépôts | PASS; seuls des avis de conversion LF→CRLF ont été émis par Git. |

Node >=20.10 est déclaré, mais seuls Node 26.8.1 Windows et Node 22.16.0 Linux x64 ont été testés pendant Mission 11. Aucun serveur Minecraft Linux ni ARM64 n'a été exécuté.
Le `npm ci` Windows n'a pas utilisé `--ignore-scripts` et a exécuté le `prepare` du projet, mais npm 11 a averti que le postinstall d'`esbuild@0.27.0` n'était pas approuvé par sa politique locale `install-scripts`. Build, tests et lint passent malgré cela. Le `npm ci` Linux npm 10 n'a pas présenté cette restriction; ce point reste à revoir si `tsx`/esbuild devient une dépendance runtime de la candidate.

## Artefacts, Git et suites

La candidate locale se trouve sous `C:/Users/qperr/minecraft-mcp-test/release-candidate/`; le manifeste et les SHA-256 y indiquent les noms et versions **effectifs**. La version source reste `2.0.4`; `2.1.0-beta.1` n'est qu'une proposition de version future. Les deux branches et leurs HEAD initiaux sont restés inchangés (`feature/processia-integration` / `8c50ee5` et `master` / `d4c217c`). Des modifications antérieures nombreuses subsistent intentionnellement non commitées, dont les changements Java/GUI de Processia; `.gitignore` et `todo.txt` ont été préservés.

Plan de commits **non exécuté** : (1) socle MCP universel et tests, (2) bridge autonome/sécurité Java, (3) GUI expérimental et tests, (4) documentation/candidate après revue des diff et secrets. Avant une bêta publique : décider du risque `uuid` et des licences/notices, fixer le numéro de version, choisir explicitement l'exclusion ou le statut expérimental du GUI, puis exécuter la revue humaine. Pour annoncer ARM64, effectuer un test natif autorisé. Pour annoncer les valeurs Processia privées, fournir un adaptateur qui les expose et les comparer au menu. Aucune de ces décisions n'a été présumée.
