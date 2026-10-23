# Mission 12 — MCP universel, candidate locale (2026-10-16)

## Décision

**PARTIAL — BETA WITH EXCLUSIONS**, en attente de décision explicite sur le risque npm et d'autorisation de publication. Aucune publication, commit, tag ou push. Version source et archive locale : **`2.1.0-beta.1`**. Bridge autonome : **`0.1.0`**. Processia `0.1.0` n'est pas inclus par défaut.

## Audit et architecture

MCP : branche `feature/processia-integration`, HEAD initial `8c50ee5`. Processia : branche `master`, HEAD initial `d4c217c`. Les diffs préexistants des missions antérieures ont été préservés; aucun reset ni indexation. Le cœur reste indépendant de Processia : `bot` fonctionne sans bridge, `bridge-only` n'invente pas un joueur, `auto` tente un fallback authentifié et borné. Le JAR `neoforge-bridge` est un mod distinct compilable sans Processia. Registres et IDs NeoForge sont liés à l'identité du serveur et à l'epoch, jamais généralisés entre sessions. Les capabilities génériques exposent seulement les API publiques disponibles; les détails privés d'un mod requièrent un adaptateur. Les preuves runtime vanilla/NeoForge/Processia/Mekanism de Mission 11 sont historiques sur l'état de code alors testé. Mission 12 n'a pas relancé les quatre profils Minecraft pour des changements limités à version, documentation, licence du JAR et correction gameplay Processia testée en GameTest.

## Sécurité `uuid`

Voir [la décision de risque détaillée](MISSION12_SECURITY_DECISION.md). Audits finaux : **15** alertes npm au total (10 modérées, 5 élevées), **6** modérées en production. Les six entrées de production remontent à `uuid@8.3.2`/`uuid@10.0.0` via MSAL/yggdrasil et l'advisory GHSA-w5hq-g745-h8pq. Une copie isolée avec override `uuid@11.1.1` passe `npm ci`, build, **231 tests**, lint et audit production à zéro, mais le flux Microsoft et la compatibilité de l'override hors contrainte n'ont pas été validés en runtime. Aucun override n'a été appliqué au lockfile principal. **Classement proposé : ACCEPTABLE FOR RESTRICTED BETA, non accepté à ce stade.** Une approbation utilisateur reste nécessaire; sinon publication bloquée.

## Licences et artefacts

Le MCP porte Apache-2.0 et `LICENSE` est inclus par npm pack. Le bridge autonome porte MIT dans `neoforge.mods.toml`; son JAR contient désormais la copie de `Processia/LICENSE` et une tâche Gradle vérifie la présence du texte et `Implementation-Version: 0.1.0`. Processia est un mod indépendant et son JAR ne figure pas dans la candidate MCP. Le bridge et le MCP ne redistribuent pas les JAR Minecraft/NeoForge. Les dépendances npm sont installées séparément depuis le lockfile; l'inventaire des licences de production accompagne la candidate. La revue juridique de textes tiers avant publication reste à faire : l'inventaire de métadonnées n'est pas une autorisation de redistribution d'assets.

Candidate locale : `C:/Users/qperr/minecraft-mcp-test/release-candidate/mission12/`. Elle contient l'archive npm, le JAR du bridge, `SHA256SUMS`, un manifeste JSON, les notes de release, la matrice de compatibilité, les notices et le rapport de sécurité. Le contenu de l'archive a été inspecté : aucun credential, monde, log, `.env`, code de test ou fichier temporaire. Les checksums sont calculés après copie des artefacts.

## Validation du code final

| Cible | Résultat de cette mission |
|---|---|
| Windows x64, Node 26.8.1 | `npm ci`, build, **231/231 tests**, lint : PASS. |
| Linux x64 WSL, Node 22.16.0 | Copie isolée du même code/lockfile, `npm ci`, build, **231/231 tests**, lint : PASS. MCP stdio : **56 outils** listés; sans bridge configuré, `bridge-only-requires-generic-neoforge-bridge` est renvoyé explicitement. Aucun serveur Minecraft Linux exécuté. |
| Processia Java 21 | Build, tests forcés, `checkSideSeparation` : PASS, **24/24 JUnit**. Serveur GameTest isolé : **46/46 requis**. |
| Bridge Java 21 | Build, tests forcés, contrôle version/licence JAR : PASS, **5/5 JUnit**. |
| `npm audit` / `npm audit --omit=dev` | PARTIAL sécurité : 15 / 6 alertes, sans correction forcée. |
| Windows runtime Minecraft | NOT TESTED dans Mission 12; se reporter aux preuves Mission 11 avec leur version et leurs limites. |
| ARM64 natif | NOT TESTED : aucun hôte ARM64 autorisé dans cette mission. |

## Périmètre proposé pour bêta privée

Windows x64 et Linux x64; Minecraft Java 1.21.1 / NeoForge 21.1.259; modes `bot`, `bridge-only`, `auto`; découverte dynamique des registres/namespaces et inspection serveur read-only des blocs, BlockEntities, inventaires, FE et fluides via capabilities standard. Processia est facultatif; Mekanism a une preuve historique via ses capabilities publiques. GUI **EXPERIMENTAL**, menus non garantis et champs privés non exposés. Placement Mineflayer validé historiquement sur vanilla, pas sur bloc moddé via client vanilla rejeté. Chunks chargés uniquement, pas de joueur en `bridge-only`, ARM64 exclu. Aucun secret dans les exemples.

## Plan de commits, non exécuté

1. **MCP** `feat(core): universalize Minecraft registry and bridge modes` — `src/services/*`, `src/bridge/*`, `src/config.ts`, `src/main.ts`, `src/tools/registry-tools.ts`, `src/tools/bridge-tools.ts`, tests correspondants; vérifier les dépendances croisées et le diff indexé.
2. **MCP** `feat(bot): validate session and confirmed vanilla placement` — `src/bot-connection.ts`, `src/tools/block-tools.ts`, tests et service ping.
3. **Processia** `feat(bridge): harden standalone NeoForge bridge` — `neoforge-bridge` sources, tests, ressources, build et README; licence embarquée et JAR contrôlé.
4. **Processia + MCP**, commits séparés `feat(gui): stabilize experimental harness` et `feat(mcp): expose experimental GUI workflow` — classes client Processia / `src/tools/gui-tools.ts`, tests et docs; dépend du bridge.
5. **Processia** `fix(machine): reset processing state when clearing inventory` — `WorkshopBlockEntity`, `M2EnergyGameTests`, configuration de GameTest isolé et rapport de reprise.
6. **MCP** `docs(release): prepare 2.1.0 beta candidate` — package/lockfile version, README, guides, rapports de release et sécurité, après décision sur le risque. Les fichiers préexistants non liés (`todo.txt`, `.gitignore` personnel, mondes, logs, `.env`) restent exclus.

Avant chaque commit éventuel : chemins explicites, inspection du staging, `git diff --cached --check`, recherche de secrets, builds/tests pertinents et approbation utilisateur. Aucun commit n'a été créé ici.

## Publication et rollback ultérieurs

Publication proposée seulement après acceptation du risque, revue des licences, artefacts/checksums et décision sur périmètre GUI. Préparer alors des commits séparés et une GitHub Release brouillon; npm exige confirmation du compte/package. En cas de régression, revenir à l'archive précédente et désactiver le bridge côté environnement de test; ne jamais effacer un monde pour rollback. Cette section est un plan, aucune commande de publication n'a été exécutée.

## Décisions utilisateur restantes

1. Accepter ou refuser explicitement les six alertes modérées de production pour une bêta **restreinte**, ou attendre une correction amont/une validation Microsoft de l'override.
2. Approuver le périmètre, les notices et les exclusions de bêta avant tout commit, tag, push ou publication.
3. Valider manuellement le gate visuel Processia M2-V01; trancher CONF-31/CONF-32 avant les fonctionnalités qui en dépendent.
