# Mission 10 — validation finale locale (2026-10-14)

## Verdict

**PARTIAL — BETA POSSIBLE WITH EXCLUSIONS** pour le cœur MCP 2.0.4. Les quatre profils isolés ont été rejoués, et le parcours graphique Crusher a été observé sur un seul client. Le runner `gui-run-e2e` a échoué sur une incompatibilité de forme de réponse du bridge générique. Le correctif est compilé et testé unitairement, mais son parcours graphique n'a pas été rejoué : le client unique avait été arrêté conformément à la contrainte de session. Une bêta ne doit donc promettre ni automatisation GUI complète, ni placement de blocs moddés garanti, ni support ARM64 validé. Aucune publication, aucun commit et aucun push.

## Corrections de cette mission

- `Processia/src/main/java/com/trycky/processia/client/GuiTestHarness.java` : action explicite `/v1/open-pause` dans un monde prêt, ouverture via `PauseScreen`, transition d'écran sûre si `screenClass=null`, et `/v1/set-music-zero` limité à la catégorie Music depuis `SoundOptionsScreen` en mode de test acquitté.
- `Processia/.../GuiWaitConditions.java` et son test : l'écran nul d'un monde prêt est normal; vérification des classes d'écran sans déréférencer JSON null.
- `src/tools/gui-tools.ts` et `tests/gui-tools.test.ts` : outils `gui-open-pause` et `gui-set-music-zero`, condition `screen:<classe>` et tests; lecture E2E de `inventory.faces[face=unsided].items` et de `energyCapabilities[face=unsided]`. Les slots par face ne sont jamais pris pour des indices de menu globaux. Les valeurs Processia privées de progression/combustion/redstone restent `INCONCLUSIVE` si seul le bridge générique est présent.
- Documentation courante mise à jour dans README, INSTALLATION, BRIDGE_ONLY_MODE, RELEASE_READINESS, RELEASE_GUIDE et RELEASE_NOTES_DRAFT. Les rapports précédents sont conservés comme preuves historiques.

## GUI réel, un seul client

Le serveur Processia jetable préexistant et le même client graphique ont été employés sur `127.0.0.1:25665/25677/25678`. Au départ, `clientReady=true`, `interactionReady=true`, `screenClass=null` et aucun écran de chargement. `gui-open-pause` a ouvert `PauseScreen`, puis les clics réels ont mené à `OptionsScreen` et `SoundOptionsScreen`. `gui-set-music-zero` a renvoyé `before=1, after=0`, puis `before=0, after=0`. La configuration audio personnelle n'a pas été modifiée.

Deux screenshots du monde prêt ont été capturés avec dimensions et SHA-256 contrôlés : 1280×720 (`8e13594eba3aa52e0bcd648d9878a19d20afd21012c440810cc937af24d1e451`) et 1600×900 (`7970b1573e45207b2cd04a202cb92c71b128f6e1c2863aa3f5f14aecce012e48`). Fichiers PNG et réponses MCP : `C:/Users/qperr/minecraft-mcp-test/artifacts/mission10-gui/` et `C:/Users/qperr/minecraft-mcp-test/logs/mission10-gui-control.json`.

Le bridge a confirmé `processia:crusher` en `(12,112,-13)`, block state brut `26702`, BlockEntity `processia:crusher`, FE `10000/10000` et sortie `processia:iron_dust ×2`. Le client a ouvert `WorkshopScreen`/`WorkshopMenu`, titre Crusher, menu `processia:crusher`, slots 0–37 et valeurs synchronisées FE `10000/10000`, progression `0`, combustion `0`, redstone `0`. Un screenshot réel du menu et un survol ont affiché l'infobulle « Iron Dust »; un second survol a affiché « Redstone control / Ignore redstone ». La fermeture du menu a ramené `interactionReady=true`. Identité de cette session : `8a5a9825-a992-46db-8cbe-76af164d0ca5`; epoch bridge `a960a211-d8e6-43ad-a7f2-84ef407da8ea`; epoch GUI `a10003fc-7451-411b-8890-19e33b253ef7`.

**Échec observé :** `gui-run-e2e` ancien a retourné `FAIL gui-e2e-recipe-output-timeout` malgré la sortie déjà présente. Il cherchait `inventory.items` alors que le bridge générique retourne `inventory.faces[].items`, et ignorait `energyCapabilities` sans `processiaMachine`. Les tests de non-régression corrigent ces hypothèses. Un nouveau PASS runtime du runner n'est pas revendiqué. Une vraie exécution de recette, un transfert de slot et un clic de contrôle suivi d'une lecture serveur restent non testés.

## Matrice runtime rejouée

Tous les appels ci-dessous passent par le catalogue MCP stdio réel, et non par des stubs. Les profils ont été lancés **séquentiellement** via `Start-IsolatedTestServer.ps1`, et chacun a été arrêté avant le suivant. Aucun endpoint personnel n'a été interrogé.

| Profil | Résultat observé | Preuve |
|---|---|---|
| Vanilla | Mineflayer connecté à Minecraft 1.21.1; 56 outils listés; capacités, position, bloc, inventaire et recherche bornée appelés. Le placement avec une pile légitime non vide reste non démontré. | `logs/mission10-vanilla-tools.json` |
| NeoForge générique seul | Bridge authentifié; 118 types de registres actualisés, namespaces, inspection de bloc/chunk; chunk non chargé refusé et outil joueur `bot-required`; HTTP 401 sans bearer sur le handshake. | `logs/mission10-neoforge-generic-bridge-only.json`, `logs/mission10-generic-inspection.json` |
| Processia | Six blocs M2 résolus depuis l'epoch courant, IDs de bloc `1066` à `1071` dans cette session; Crusher et capacités inspectés. Recettes et énumération spécialisées retournent explicitement `processia-recipes-require-processia-adapter` et `processia-machine-search-requires-processia-adapter` lorsque seul le bridge générique est configuré. | `logs/mission10-neoforge-processia-bridge-only.json` |
| Mekanism 10.7.15 | 123 types de registres, namespace et trois blocs résolus : Energy Cube ID `1206` (FE `0/1600000`), Fluid Tank ID `1177` (eau `1000/32000` mB déjà présente), Bin ID `1120` (ItemHandler). Le mode `auto` a constaté le rejet NeoForge du bot vanilla et a basculé vers le bridge authentifié. | `logs/mission10-neoforge-third-party-bridge-only.json`, `logs/mission10-auto-valid-name.json` |

Les IDs sont des **observations de sessions distinctes**, jamais des constantes à réutiliser. La session Processia rejouée avait l'identité `0627d429-0d12-4ab5-8eee-1e667d22c23e` et l'epoch source `8cde1082-11b0-4828-aeb1-f9dae691cf93`. Un redémarrage a donc donné une identité et un epoch nouveaux par rapport à la session GUI; l'invalidation de mappings n'a pas été affirmée au-delà des outils déjà testés automatiquement. Aucun réservoir n'a été rempli de nouveau.

## Builds, tests, plateformes

- Windows : `npm ci`, `npm run build`, `npm test` **230/230 PASS**, `npm run lint`, `git diff --check` PASS.
- Ubuntu 24.04 WSL **x86_64** : Node portable 22.16.0/npm 10.9.2 en `/tmp/processia-mission10-linux`, copie isolée du code final et `npm ci --ignore-scripts`, build, **230/230 tests** et lint PASS. `git diff --check` a aussi passé sur la source montée sous WSL. Ce n'est pas une preuve de serveur Minecraft Linux.
- Processia Java 21 : `gradlew.bat build test --rerun-tasks --no-daemon --max-workers=1` PASS, **24 tests, 0 échec**, séparation client/serveur vérifiée par `checkSideSeparation`.
- Bridge générique : `..\gradlew.bat -p . build test --rerun-tasks --no-daemon --max-workers=1` PASS, **5 tests, 0 échec**.
- ARM64 : **BLOCKED — no native ARM64 host** dans cet environnement.

## Dépendances et candidate locale

`npm audit` : **15 avis** (10 modérés, 5 élevés, 0 critique); `npm audit --omit=dev` : **6 modérés**, aucun élevé/critique. Chaîne concernée : `mineflayer → minecraft-protocol → prismarine-auth/yggdrasil → @azure/msal-node → uuid`; advisory direct `GHSA-w5hq-g745-h8pq` sur `uuid <11.1.1`. Cette chaîne est pertinente au mode bot et à la tentative initiale du mode auto; le bridge-only n'exécute pas Mineflayer mais le package reste installé. L'atteignabilité exacte de l'advisory dans les chemins utilisés n'est pas démontrée. `npm audit fix` propose des rétrogradations majeures incompatibles; aucune dépendance ni lockfile n'a été modifié par cette mission. JSON d'audit : `logs/mission10-npm-audit*.json`.

La candidate **locale, non publiée, version effective 2.0.4** est dans `C:/Users/qperr/minecraft-mcp-test/release-candidate/` : archive npm, JAR bridge, JAR Processia, `CANDIDATE.json` et `SHA256SUMS.txt`. Les empreintes à utiliser sont celles de `SHA256SUMS.txt`, générées après le dernier empaquetage. L'inventaire npm ne contient ni credential, secret, monde, log, `.env`, JAR ou classe Java. Le package inclut encore des sources/tests publics; à revoir avant publication.

## Git et limites

MCP : branche `feature/processia-integration`, HEAD `8c50ee5`. Processia : `master`, HEAD `d4c217c`. Les nombreux changements antérieurs restent non commités; cette mission a modifié le harness GUI, ses tests, `gui-tools.ts`, ses tests et la documentation citée. `.gitignore` n'a pas été modifié. Aucun commit, tag, push ou publication. Les ports isolés 25665, 25677, 25678 sont libres à la clôture.

Priorités restantes : (1) rejouer `gui-run-e2e` corrigé sur un prochain client graphique **sans en lancer deux simultanément**; (2) valider transfert de slot/recette et contrôles avec état serveur; (3) prouver placement adjacent/distant avec pile légitime et absence de placement tardif; (4) étudier/remédier aux 6 advisories de production sans rétrogradation incompatible; (5) valider ARM64 sur un vrai hôte.
