> Mission 13: local candidate 2.1.0-beta.1 packaged and hashed; Windows/Linux x64 each pass npm ci, build, 232 tests and lint. The runtime Crusher GUI runner returns PARTIAL: identity/menu/energy comparisons pass, private progress fields remain INCONCLUSIVE, and the pre-existing output was not treated as a recipe result. Processia's nickel V0.2 slice passes 49/49 GameTests. Six moderate production npm advisories remain pending owner approval; M2-V01 remains a manual partial gate. No publication occurred. See `MISSION13_MCP_FINAL_REPORT.md`.
# Brouillon de notes — candidat universel NeoForge

> Candidate Mission 12 : version effective `2.1.0-beta.1` dans `package.json` et l'archive locale, sans publication. Bridge autonome `0.1.0` indépendant de Processia. GUI expérimental ; Windows/Linux x64 validés par build, lint et 231 tests ; ARM64 non testé ; six alertes npm modérées de production non encore acceptées. Voir [le rapport Mission 12](MISSION12_MCP_RELEASE_REPORT.md). Les notes Mission 11 ci-dessous sont historiques.

> Mission 11 : `gui-run-e2e` a été rejoué sur un seul client réel, avec transfert d'un Raw Iron et augmentation vérifiée de la sortie Crusher de 2 à 3 Iron Dust. Le placement vanilla adjacent et deux distances sont confirmés sur le serveur isolé. Ces essais ne couvrent pas le placement de blocs moddés, ARM64, ni les valeurs privées Processia absentes du bridge générique. La version effective demeure `2.0.4`; `2.1.0-beta.1` est une proposition non appliquée. Voir [MISSION11_FINAL_REPORT.md](MISSION11_FINAL_REPORT.md).

> Mise à jour Mission 10 : le code reste en version `2.0.4`. Les quatre profils runtime ont été rejoués. Le GUI Processia expérimental a ouvert le Crusher, capturé un vrai framebuffer et lu des infobulles; le runner E2E a révélé une ancienne hypothèse sur la forme des capacités génériques, corrigée et testée unitairement mais non rejouée graphiquement. La prise en charge GUI complète et ARM64 ne doit pas être annoncée. Voir [MISSION10_FINAL_REPORT.md](MISSION10_FINAL_REPORT.md).

**Version effective de la candidate locale :** `2.1.0-beta.1`  
**Statut :** brouillon interne, non publiable.

## Changements

- Modes MCP `bot`, `bridge-only` et `auto`, avec résultats explicites lorsque Mineflayer ou un bridge manque.
- Découverte générique de namespaces/registres NeoForge et inspection bornée en lecture seule des blocs, BlockEntities et capacités standard disponibles.
- Adaptateur Processia facultatif, outils de diagnostic registry et harness graphique instrumenté.
- Durcissement des credentials éphémères, identité serveur/epoch, limitations loopback et contrôles de chunks chargés.
- Vérification post-action de placement Mineflayer et tests de régression associés.

## Compatibilité évaluée

- Minecraft Java 1.21.1, protocole 767; NeoForge 21.1.259.
- Windows x64, Java 21, Node 26.8.1/npm 11.19.0 dans la reprise courante.
- Processia et Mekanism ont des preuves runtime historiques dans la matrice; leurs profils n'ont pas tous été rejoués après l'état final actuel.
- Linux x64 a des validations antérieures, à refaire sur le lockfile final. Linux ARM64/Raspberry Pi non validé.

## Limitations avant toute publication

- Le parcours GUI final n'est pas clos : ouverture interactive du Crusher, captures après `interactionReady` et réglage Music à 0 % ont été observés; le runner E2E corrigé, les transferts de slots et l'exécution de recette attendent encore une validation graphique.
- Six advisories modérés de production restent dans la chaîne Mineflayer/protocole/auth; aucun downgrade incompatibilisant appliqué.
- Le support de capacités dépend de ce que les APIs publiques du mod exposent. Le bridge ne promet pas l'inspection de données privées arbitraires ou le pilotage de tout mod tiers.
- Les IDs numériques sont éphémères et attachés au serveur/epoch, jamais des constantes portables.

## Installation / sécurité

Voir [INSTALLATION.md](INSTALLATION.md). Le bridge reste désactivé par défaut, local uniquement et authentifié par credential éphémère. Aucun secret ne doit apparaître dans les variables commitées ou logs.

Crédits : Mineflayer, Prismarine, Minecraft Data, NeoForge et leurs auteurs respectifs selon leurs licences; vérifier et conserver les notices applicables dans l'archive finale.
