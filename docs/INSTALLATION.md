> Mission 13 candidate note: local artifacts are in `C:/Users/qperr/minecraft-mcp-test/release-candidate/mission13/`; Windows x64 and Linux x64 each pass `npm ci`, build, 232 tests, lint, and stdio tool listing. This does not validate ARM64 or a Linux-hosted Minecraft server. UUID risk acceptance remains pending. See [Mission 13 report](MISSION13_MCP_FINAL_REPORT.md). The notes below include historical mission snapshots.
# Installation et configuration

## Candidate Mission 13

La candidate locale non publiée porte la version MCP `2.1.0-beta.1` et le bridge autonome `0.1.0`. Windows x64 et Linux x64 ont passé la compilation, le lint et 231 tests avec le lockfile courant. Le GUI reste expérimental ; les six alertes npm modérées en production requièrent une décision de risque avant publication. Voir [le rapport Mission 12](MISSION12_MCP_RELEASE_REPORT.md). Les validations de missions précédentes ci-dessous sont historiques.

## Validation Mission 11

Le code courant a été validé sur Windows x64 (Node 26.8.1) et Linux x64 sous WSL (Node 22.16.0) avec `npm ci`, build, 231 tests et lint. Le mode graphique reste expérimental et requiert **un seul** client Processia instrumenté, un bridge authentifié, ainsi que `TEST_MUTATION` et l'acquittement du monde jetable pour les interactions. Les essais de placement vanilla et de recette Crusher sont détaillés dans [MISSION11_FINAL_REPORT.md](MISSION11_FINAL_REPORT.md). La version effectivement installable reste `2.0.4`; ARM64 n'est pas validé.

## Validation Mission 10

Le socle MCP 2.0.4 a été compilé et testé sur Windows x64 et Ubuntu 24.04 x64 sous WSL (Node portable 22.16.0, npm 10.9.2). Ce test Linux ne valide pas un serveur Minecraft Linux ni ARM64. Les profils de test de Mission 10 utilisaient les ports isolés 25665 (jeu), 25677 (bridge) et 25678 (GUI). Depuis Mission 29.0, le port 25665 est réservé au serveur historique et refusé par le profil `processia-test` et le banc runtime; tout port de test doit être choisi explicitement. Le parcours GUI expérimental requiert un client Processia instrumenté distinct et un bridge authentifié; voir [MISSION10_FINAL_REPORT.md](MISSION10_FINAL_REPORT.md).

## Prérequis

- Node.js 20.10 ou plus récent et npm.
- Minecraft Java 1.21.1 pour la matrice testée; Mineflayer/runtime vérifiés sur protocole 767.
- Java 21 et NeoForge 21.1.259 uniquement pour héberger le bridge générique.
- Processia n'est pas requis pour l'usage vanilla ni pour le bridge NeoForge générique.

## MCP

Depuis une copie du dépôt :

```sh
npm ci
npm run build
npm start -- --host 127.0.0.1 --port <port-de-test-isolé> --username MCPBot
```

Le port ci-dessus est un exemple de serveur Minecraft cible, pas un port à ouvrir par le MCP. Le serveur MCP utilise stdio pour le transport MCP. Pour Claude Code/Codex, configurer un processus MCP stdio local selon la documentation du client. Ne pas stocker de secret dans `.mcp.json`.

## Vanilla / mode bot

Configurez l'hôte, le port et le nom de bot selon l'aide de `minecraft-mcp-server --help`. Le bot Mineflayer fournit les outils d'état joueur, inventaire, navigation et interaction que le protocole expose. Les outils refusent explicitement les capacités indisponibles.

## Bridge NeoForge générique

Construire depuis le dépôt Processia, sans installer Processia dans le serveur :

```sh
./gradlew -p neoforge-bridge build --no-daemon --max-workers=1
```

Copier le JAR de `neoforge-bridge/build/libs/` dans `mods/` d'un serveur NeoForge 1.21.1 isolé. Par défaut, le bridge est désactivé. Pour un environnement de test local, définir `MINECRAFT_MCP_BRIDGE_ENABLED=true`, `MINECRAFT_MCP_ENVIRONMENT=development` et l'endpoint du serveur; le bind HTTP reste loopback. Ne pas activer dans un serveur public.

Le mod génère un secret éphémère dans un fichier credentials à ACL propriétaire uniquement si le stockage local le permet. Le MCP lit ce fichier via `MINECRAFT_MCP_BRIDGE_CREDENTIAL_FILE`; ne pas copier son contenu dans une commande, un dépôt ou un journal. La session handshake vérifie le protocole, l'identité serveur et l'époque. Consultez [BRIDGE_ONLY_MODE.md](BRIDGE_ONLY_MODE.md) et [universal-neoforge-bridge.md](universal-neoforge-bridge.md) pour les noms d'environnement et le contrat détaillés.

## Modes

- `bot` : outils nécessitant un joueur Mineflayer.
- `bridge-only` : inspection serveur autorisée sans joueur; les outils joueur renvoient `bot-required`.
- `auto` : utilise Mineflayer lorsqu'il se connecte et le bridge authentifié lorsque disponible; aucune capacité joueur n'est simulée.

Processia expose en plus des inspections spécifiques si son adaptateur est installé. Mekanism et les autres mods restent des consommateurs du bridge générique; capacités accessibles dépendent de leur API publique (`IItemHandler`, `IEnergyStorage`, `IFluidHandler`) et du bloc inspecté.

## Sécurité / dépannage

- N'exposez ni bridge HTTP ni GUI harness sur une interface publique. N'ouvrez aucun port Internet.
- Utilisez des mondes jetables isolés pour les outils d'interaction; le bridge générique est en lecture seule.
- Un bridge sans credentials valides ou dont l'identité/epoch diffère doit rester indisponible. Redémarrage ou reload exige un refresh; les IDs numériques sont liés à leur époque.
- Les chunks non chargés ne sont jamais forcés par l'inspection serveur.
- Si Mineflayer signale `PartialReadError` sur les données de recettes, l'erreur ne doit pas être convertie en inventaire vide.
- Capture GUI et menus nécessitent un client graphique instrumenté distinct, le harness authentifié et la même identité/époque de serveur. Cette voie demeure expérimentale et n'est pas annoncée comme complète.
