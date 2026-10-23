# Mission 13 — rapport final MCP et candidate bêta privée

Date: 2026-10-16. Dépôt `processia-mcp-server`, branche `feature/processia-integration`, HEAD historique `8c50ee564c8a0983a07187e8d98ba723dee61c3b`. Les changements locaux cumulés ont été préservés; aucun commit, push, tag, publication ou transfert n'a été effectué.

## Verdict

**PARTIAL — candidate locale prête à revue, distribution suspendue aux décisions du propriétaire.** `2.1.0-beta.1` est la version réellement déclarée dans `package.json` et dans le tarball construit. Les builds/tests/lint Windows et Linux x64 passent. Le risque de production uuid reste ouvert et n'est pas accepté au nom du propriétaire. M2-V01 est encore un gate manuel partiel. La candidate est un dossier local auditable, pas une distribution effective.

## Baseline et changements

Versions constatées: Node 26.8.1/npm 11.19.0 sur Windows; Node 22.16.0/npm 10.9.2 sur Ubuntu 24.04 x64/WSL; Mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, SDK MCP 1.32.1. Minecraft 1.21.1/protocole 767, NeoForge 21.1.259, Java Temurin 21.0.12.1.

Le travail local existant comprend l'intégration universelle et le mode `bot`/`bridge-only`/`auto`, l'isolation serveur/epoch, les validations de placement vanilla, le bridge authentifié, les outils registry/capabilities, le harness GUI et les tests associés. Cette mission a mis à jour les notes de statut, préparé une candidate, produit un inventaire SPDX de 197 dépendances de production et ajouté ce rapport. Aucun changement de dépendance n'a été demandé par cette mission; `npm ci` a installé le lockfile courant.

## Sécurité uuid

Audit fraîchement exécuté sur le lockfile courant:

| Audit | Total | Modérées | Élevées | Critiques |
|---|---:|---:|---:|---:|
| `npm audit` | 15 | 10 | 5 | 0 |
| `npm audit --omit=dev` | 6 | 6 | 0 | 0 |

Les six avis production remontent à la chaîne `mineflayer → minecraft-protocol → prismarine-auth → @azure/msal-node → uuid` et `minecraft-protocol → yggdrasil → uuid`. L'advisory `GHSA-w5hq-g745-h8pq` signale le contrôle de bornes de buffer de certains appels uuid v3/v5/v6. Les plages parentes courantes ne permettent pas uuid 11.1.1; une copie isolée avec cet override a passé des tests historiques, mais le flux Microsoft n'a pas été vérifié. Aucun override, downgrade ou `npm audit fix --force` n'a été appliqué ici.
Contrôle des versions publiées le 2026-10-16 via `npm view`: `minecraft-protocol` latest 1.68.0 conserve `prismarine-auth ^3.1.1` et `yggdrasil ^1.4.0`; `prismarine-auth` 3.1.1 demande `@azure/msal-node ^2.0.2`, dont la dernière version 2.x publiée est 2.16.3; `yggdrasil` 1.8.0 demande toujours `uuid ^10.0.0`. `@azure/msal-node` 7.1.0 est hors plage parentale. Une mise à jour compatible du graphe ne supprime donc pas les deux instances vulnérables observées. Les sources installées consultées appellent `uuid.v4()` dans `GuidGenerator.mjs` et `yggdrasil/src/Client.js`; `prismarine-auth` emploie séparément `uuid-1345.v3(namespace,name)`. Aucun appel observé ne fournit un buffer aux API v3/v5/v6 visées par l'advisory; cela réduit le scénario d'exposition connu sans prouver l'inatteignabilité de tous les usages transitifs. L'avis officiel décrit ces conditions et les versions corrigées [GitHub Advisory GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

**Classification proposée:** `ACCEPTABLE FOR RESTRICTED PRIVATE BETA — PENDING OWNER APPROVAL`. Cette mention n'est pas un consentement utilisateur. Attendre une approbation explicite avant de transmettre ou installer la candidate chez un testeur.

## Licences et contenu distribué

- MCP: Apache-2.0; le tarball inclut `LICENSE`.
- Bridge générique: MIT déclaré dans `neoforge.mods.toml`; le JAR embarque `LICENSE_minecraft_mcp_bridge`, identique octet pour octet au `Processia/LICENSE`, et `Implementation-Version: 0.1.0` vérifié.
- Tarball npm: 66 entrées, aucune dépendance bundled; l'inventaire `DEPENDENCY_LICENSES.md` liste les 197 entrées runtime verrouillées et leurs métadonnées déclarées (0BSD, Apache-2.0, BSD, BSD-2-Clause, BSD-3-Clause, CC0-1.0, ISC, MIT).
- Aucun JAR Processia n'est inclus. Les assets Processia ne font pas partie du tarball MCP. L'inventaire est une revue de métadonnées, pas un avis juridique; vérifier les textes upstream avant redistribution élargie.
- Contenu inspecté: aucun `.env`, credential, monde, log, archive ou fichier de test dans l'archive npm.

## Candidate locale

`C:/Users/qperr/minecraft-mcp-test/release-candidate/mission13/`

| Fichier | SHA-256 | Taille |
|---|---|---:|
| `minecraft-mcp-server-2.1.0-beta.1.tgz` | `f9c570c6f6da4aa12b2ddc2df9d4a517b65356a01a9862f3220523c307fa96e8` | 75,313 bytes |
| `minecraft-mcp-bridge-0.1.0.jar` | `2b04d65322ea497878727b1aa81ce12395e6a4e788f910a2317376953af05b32` | 35,063 bytes |

Le dossier comprend aussi `SHA256SUMS.txt`, `MANIFEST.json`, notes, guides Windows/Linux, matrice, known issues, décision de risque, rollback, guide testeur privé, notices et inventaire de licences. Les hashes sont inscrits dans le manifeste/checksum. Processia est exclu. Rien n'a été envoyé à un tiers.

## Tests exécutés dans Mission 13

| Cible | Commande | Résultat |
|---|---|---|
| Windows MCP | `npm ci` | PASS, 507 packages; prepare/build exécuté; 15 advisories annoncées par npm. |
| Windows MCP | `npm run build` | PASS. |
| Windows MCP | `npm test` | PASS, 232/232. |
| Windows MCP | `npm run lint` | PASS. |
| Windows audit | `npm audit`, `npm audit --omit=dev` | PASS en tant que diagnostics; 15/6 advisories documentées, codes non nuls attendus car l'audit trouve des avis. |
| Windows package | `npm pack --pack-destination <candidate> --json` et `tar -tzf` | PASS; archive créée, 66 entrées inspectées, aucun contenu privé; `bundled: []`. |
| Linux x64 / WSL | `npm ci`, build, test, lint | PASS; 232/232 tests sous Node 22.16.0. |
| Linux MCP stdio | Client SDK `StdioClientTransport` → vrai `dist/main.js` en `bridge-only`, puis `tools/list` | PASS; 56 outils. Aucun bridge n'était configuré: le processus a correctement journalisé `bridge-only-requires-generic-neoforge-bridge`; aucune connexion Minecraft n'a été tentée. |
| Git diff | `git diff --check` | PASS après mise à jour des rapports; état final réexaminé ci-dessous. |

`npm ci` sous npm 11.19.0 a aussi signalé que le script postinstall `esbuild@0.27.0` n'est pas couvert par la liste npm des scripts autorisés. Malgré cet avertissement, installation, compilation, 232 tests et lint sont passés sur Windows; la copie Linux passe également. Aucun réglage npm global ni configuration MCP personnelle n'a été changé. Vérifier le comportement des scripts d'installation dans l'environnement réel de chaque testeur.
La première exécution Linux avait transmis `MINECRAFT_MCP_CONNECTION_MODE=bridge-only` à la suite unitaire, faisant échouer le test du mode par défaut. Le harnais a été corrigé pour limiter la variable au seul enfant MCP; la suite finale passe. La première commande de smoke test a aussi fini sur un code non nul à cause d'un `tail` PowerShell/WSL après les tests; la seconde vérification stdio propre a listé les 56 outils et terminé en code 0.

Logs actuels: `C:/Users/qperr/minecraft-mcp-test/logs/mission13-mcp-{ci,build,test,lint}.log`, `mission13-linux-{ci,build,test,lint,stdio}.log`, `mission13-npm-audit-current.json`, `mission13-npm-audit-prod-current.json`, `mission13-npm-ls-depth0.log`, `mission13-npm-pack.json`, `mission13-npm-package-files.txt`.

## Runtime GUI Processia — preuve ciblée

Une seule session graphique de test a été utilisée dans le profil isolé sur `127.0.0.1:25665`, avec bridge `127.0.0.1:25677` et harness `127.0.0.1:25678`. Le client s'est connecté réellement; le Crusher `processia:crusher` et son menu ont été reconnus. Comparaison énergie GUI/serveur: 6800/10000 des deux côtés, delta 0. Identité/menu/même block entity: PASS. Progression, burn et redstone: INCONCLUSIVE, absents de l'inspection générique. `recipe-execution` NOT_REQUESTED; la sortie iron dust déjà présente n'est pas comptée comme preuve de recette.

Le runner `gui-run-e2e` rend **PARTIAL**. Capture réelle du menu Crusher à 1600×900: `C:/Users/qperr/minecraft-mcp-test/artifacts/mission13-gui/gui-2026-10-16T14-36-35-883Z-97f3ca86-39f1-4a02-bec3-686ddff0b6bd.png`, SHA-256 `d3ebc577c2d5b5556ed906a0f6b846c3daed2af556f14016071380a713c5f2c1`. Captures monde 1280×720 et 1600×900 conservées dans le même dossier. Pas de clic de slot, transfert, recette ni mutation de bloc/inventaire réalisé dans ce run.

M2-V01 ne peut pas être fermé par ces seules captures: les cinq machines, les faces/orientations et tous les contrôles visuels requis ne sont pas couverts et l'approbation humaine manque. Voir [rapport Processia Mission 13](../../Processia/docs/MISSION13_PROCESSIA_REPORT.md) dans l'autre dépôt; ce lien local peut être absent du tarball.

## Statut de bêta et exclusions

Candidate prête pour **revue interne locale seulement**. Windows x64 et Linux x64 x86-64 sont testés. Exclure ARM64, serveur Minecraft Linux, promesse de compatibilité avec tous les menus, données privées arbitraires des mods, GUI général et placement de blocs moddés par Mineflayer vanilla. Le bridge reste opt-in, loopback-only et authentifié. Une distribution privée attend l'approbation explicite du risque uuid; une publication publique, commit, tag ou push n'est pas autorisé.

## Plan de commits proposé (non exécuté)

1. `feat(core): stabilize session modes and dynamic registries` — `src/config.ts`, `src/main.ts`, `src/bot-connection.ts`, `src/services/runtime-registry-service.ts`, `src/services/minecraft-server-ping.ts`, `src/bridge/neoforge-bridge-client.ts`, tests de connexion/config/bridge/registry; exiger npm ci/build/test/lint et revue d'identité/epochs.
2. `fix(blocks): confirm vanilla placement and bound registry scans` — `src/tools/block-tools.ts`, `tests/block-tools.test.ts`, tests bot; exiger tests négatifs timeout, chunk et confirmation état.
3. `feat(mcp): expose generic bridge and registry diagnostics` — outils bridge/registry, schémas et tests; aucun secret dans diff, stdio tool listing.
4. `feat(gui): expose experimental instrumented client workflow` — `src/tools/gui-tools.ts`, tests GUI et `docs/gui-harness-p3.md`; dépend d'un client authentifié et de l'epoch serveur.
5. `chore(release): version and package beta candidate` — `package.json`, `package-lock.json`, `src/package-version.ts`, tests de version; nécessite accord risque uuid avant distribution.
6. `docs(release): record compatibility and private beta scope` — README, guides bridge/installation, rapports mission 10–13, notices et readiness; séparer les rapports historiques des affirmations actuelles.

Liste des changements MCP observés au statut final: `README.md`; docs `UNIVERSALIZATION_REPORT.md`, `final-mission-status.md`, `gui-harness-p3.md`, `universal-neoforge-bridge.md`, `BRIDGE_ONLY_MODE.md`, `INSTALLATION.md`, rapports Mission 6–13 et readiness/release guides; `package.json`, `package-lock.json`; sources `bot-connection.ts`, `bridge/neoforge-bridge-client.ts`, `config.ts`, `main.ts`, `services/runtime-registry-service.ts`, `services/minecraft-server-ping.ts`, `package-version.ts`, outils block/bridge/gui/registry; tests de ces modules. Aucun fichier n'a été indexé.

## Contrôles finaux et limites

- Aucune connexion au port 25565 n'a été effectuée. Le serveur Minecraft test a été arrêté proprement; le client GUI s'est arrêté, et les ports 25665/25677/25678 ont été libérés après les tests.
- Aucun monde personnel, configuration MCP personnelle, secret, branche, remote ou historique Git n'a été modifié volontairement. `.gitignore` est resté intact; `todo.txt` n'a pas été touché.
- Le dépôt MCP reste non commité. Les modifications existantes sont locales et incluent du travail des missions antérieures; elles ne sont pas assimilées à un nouveau commit Mission 13.
- À décider par le propriétaire: acceptation/refus du risque uuid avant diffusion privée; approbation visuelle M2-V01 avec la planche et couverture restante; calendrier/format de commits ultérieurs. Aucun choix n'est présumé.
### Découpage exact proposé (paths; staging absent)

1. Core/session: `src/config.ts`, `src/main.ts`, `src/bot-connection.ts`, `src/services/runtime-registry-service.ts`, `src/services/minecraft-server-ping.ts`, `src/bridge/neoforge-bridge-client.ts`, `tests/config.test.ts`, `tests/bot-connection.test.ts`, `tests/runtime-registry-service.test.ts`, `tests/neoforge-bridge-client.test.ts`.
2. Placement/search: `src/tools/block-tools.ts`, `tests/block-tools.test.ts`.
3. Bridge/registry diagnostics: `src/tools/bridge-tools.ts`, `src/tools/registry-tools.ts`, `tests/bridge-tools.test.ts`.
4. GUI harness: `src/tools/gui-tools.ts`, `tests/gui-tools.test.ts`, `docs/gui-harness-p3.md`.
5. Version/package: `package.json`, `package-lock.json`, `src/package-version.ts`, `tests/package-version.test.ts`.
6. Documentation/release: `README.md`, `docs/UNIVERSALIZATION_REPORT.md`, `docs/final-mission-status.md`, `docs/universal-neoforge-bridge.md`, `docs/BRIDGE_ONLY_MODE.md`, `docs/INSTALLATION.md`, `docs/MISSION6_RUNTIME_REPORT.md`, `docs/MISSION7_FINAL_REPORT.md`, `docs/MISSION8_FINAL_REPORT.md`, `docs/MISSION9_FINAL_REPORT.md`, `docs/MISSION10_FINAL_REPORT.md`, `docs/MISSION11_FINAL_REPORT.md`, `docs/MISSION12_MCP_RELEASE_REPORT.md`, `docs/MISSION12_SECURITY_DECISION.md`, `docs/MISSION13_MCP_FINAL_REPORT.md`, `docs/RELEASE_GUIDE.md`, `docs/RELEASE_NOTES_DRAFT.md`, `docs/RELEASE_READINESS.md`, `docs/WINDOWS_RUNTIME_TEST_REPORT.md`, `docs/WINDOWS_RUNTIME_TEST_SETUP.md`.

Each proposed commit is a review boundary, not a staged changeset. Review dependency order before creating commits; no `git add` or commit was run.