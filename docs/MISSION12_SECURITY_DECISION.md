# Mission 12 — décision de risque npm proposée

**État : ACCEPTABLE FOR RESTRICTED BETA, sous réserve d'acceptation explicite par Trycky.** Cette proposition ne vaut pas acceptation. Une publication publique reste suspendue.

`npm audit` sur le lockfile de la candidate `2.1.0-beta.1` rapporte 15 alertes (10 modérées, 5 élevées), dont 6 modérées en production. Ces six noms sont une chaîne transitive vers une advisory directe sur `uuid`, [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) / CVE-2026-41907 : `mineflayer → minecraft-protocol → prismarine-auth → @azure/msal-node → uuid@8.3.2` et `minecraft-protocol → yggdrasil → uuid@10.0.0`. Les contraintes parentes sont respectivement `^8.3.0` et `^10.0.0`; `11.1.1` est hors de ces plages. Les cinq alertes élevées concernent l'outillage de développement et non l'installation production selon `npm audit --omit=dev`.

L'advisory concerne `v3`, `v5` et `v6` lorsqu'un appelant fournit un buffer et des bornes invalides. Les imports directs inspectés dans MSAL (`GuidGenerator.mjs`) et yggdrasil utilisent `v4()`. Cette revue ne prouve pas l'absence d'autres chemins atteignables ou d'un usage indirect. Le mode `bridge-only` n'instancie pas de client Mineflayer, mais le package vulnérable reste installé.

Une **copie isolée**, sans changement du lockfile principal, a forcé les deux parents à `uuid@11.1.1`. `npm ci`, build, 231 tests, lint et `npm audit --omit=dev` y passent. Aucun flux d'authentification Microsoft en conditions réelles n'a été validé sur cette copie; cet override transgresse les contraintes semver parentes. Il n'est donc pas appliqué à la candidate. Pas de `npm audit fix --force`, de downgrade ni d'override non prouvé.

Mesures proposées pour une bêta restreinte : installation locale contrôlée, bridge loopback authentifié, pas d'exposition publique, modes `bridge-only`/hors ligne privilégiés lorsqu'ils conviennent, surveillance des versions parentes et nouvel audit avant publication. Risque résiduel : authentification Mineflayer dépend d'une chaîne avec `uuid` vulnérable; l'atteignabilité de l'appel vulnérable n'est pas démontrée mais non exclue. Une validation Microsoft réelle de l'override ou une mise à jour amont compatible est nécessaire avant de déclarer `REMEDIATED`.

**Décision demandée :** accepter explicitement ce risque pour une bêta privée Windows/Linux x64 seulement, ou reporter toute distribution. Aucune acceptation n'est présumée.
