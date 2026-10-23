# Mission 9 — stabilisation et release candidate

Date : 2026-10-14. Aucun commit, tag, push ou publication n'a été réalisé.

## Verdict

**PARTIAL — release NOT READY.** Les builds/tests finaux Windows réussissent, mais la validation graphique de Mission 8 s'est interrompue et la matrice de runtime n'a pas été rejouée intégralement. Les vulnérabilités npm de production restent ouvertes.

## Vérifications reproductibles

| Commande | Résultat |
|---|---|
| `npm ci` | PASS; 507 paquets ajoutés; npm affiche 15 vulnérabilités (10 moderate, 5 high). |
| `npm run build` | PASS |
| `npm test` | PASS, 225 tests |
| `npm run lint` | PASS |
| `npm audit` | 15 advisories : 10 modérées, 5 élevées, 0 critiques. |
| `npm audit --omit=dev` | 6 advisories : 6 modérées, 0 élevée/critique. Chaîne Mineflayer/protocole/auth. |
| `npm ls --all --depth=0` | PASS; versions directes conformes au lockfile : Mineflayer 4.39.0, minecraft-protocol 1.68.0, minecraft-data 3.117.0, SDK MCP 1.32.1. |
| Processia `gradlew.bat test build --no-daemon --max-workers=1 --rerun-tasks` | PASS; 23 tests, 0 échec/erreur/ignoré; `checkSideSeparation` inclus. |
| Bridge `gradlew.bat -p neoforge-bridge test build --no-daemon --max-workers=1 --rerun-tasks` | PASS; 5 tests, 0 échec/erreur/ignoré. |
| `git diff --check` | PASS aux deux dépôts (avertissements de conversion CRLF seulement dans Processia). |

Les preuves GUI interrompues et runtime sont décrites dans [Mission 8](MISSION8_FINAL_REPORT.md). Linux ARM64 n'est pas accessible; ne pas annoncer de compatibilité native ARM64. Linux x64 WSL est une preuve antérieure, à revalider après les derniers changements.

## Outils MCP

Le catalogue documenté contient 54 outils dans les groupes vanilla, bridge/registry, Processia et GUI. L'inventaire provient de la matrice `RELEASE_READINESS.md`; cette reprise n'a pas interrogé à nouveau un client MCP connecté pour réénumérer les 54 schémas. L'enregistrement n'est pas une preuve de réussite fonctionnelle; les exigences de connexion/capacité sont indiquées dans la matrice.

## npm audit

Les 15 avis correspondent au snapshot npm de cette exécution. La correction proposée par npm rétrograderait Mineflayer/minecraft-protocol vers des versions incompatibles; aucun `--force` ni override hasardeux n'a été appliqué. La release ne doit pas être publiée tant que la chaîne de production n'a pas été corrigée ou qu'une décision de risque explicite n'a pas été prise.

## Candidat local et version

- Version source observée : `2.0.4`.
- Proposition seulement : `2.1.0-beta.1`, sous réserve de la clôture des bloqueurs et de l'approbation humaine.
- Un snapshot local non approuvé est préparé dans `C:/Users/qperr/minecraft-mcp-test/release-candidate`: `minecraft-mcp-server-2.0.4.tgz`, `minecraft_mcp_bridge-0.1.0.jar`, `processia-0.1.0.jar`, `SHA256SUMS.txt` et `CANDIDATE.json`. Les SHA-256 ont été recalculés après assemblage et sont consignés dans le fichier externe `SHA256SUMS.txt` (le rapport empaqueté n'embarque pas son propre hash). Le MCP tarball reste à la version source `2.0.4`; `2.1.0-beta.1` n'a pas été appliquée. Aucun tag ni publication n'a eu lieu.

## État Git et plan de commits

- MCP : branche `feature/processia-integration`, HEAD de référence inchangé `8c50ee5` (à recontrôler avant tout commit). Changements cumulés non commités des Missions 6–9, dont source, dépendances, tests et rapports.
- Processia : branche `master`, HEAD de référence `d4c217c` (à recontrôler avant tout commit). Modifications non commitées du bridge et du harness GUI, plus nouveaux tests.
- Aucun fichier n'a été indexé, aucun commit n'a été créé.
- Plan proposé après validation : (1) readiness et outils GUI + tests Java/MCP; (2) bridge générique/sécurité; (3) placement et modes de connexion; (4) docs/rapports; les dépendances restent un commit isolé après résolution des advisories.

Pour la liste exacte et fraîche des fichiers, utiliser les sorties `git status --short --branch` des dépôts; les modifications restent volontairement non commités.

## Blocages avant publication

1. Terminer et prouver le parcours du même profil GUI : Options → Music & Sounds → Music à 0, captures stabilisées aux deux résolutions et menu Processia.
2. Rejouer les scénarios runtime vanilla, NeoForge générique, Processia, Mekanism et auto fallback après le lockfile actuel.
3. Revalider Linux x64 sur le code final; ARM64 reste non testé.
4. Traiter/évaluer formellement les 6 vulnérabilités de production.
5. Après levée des bloqueurs, générer les artefacts et checksums dans le dossier de candidate hors dépôt, puis les inspecter avant approbation.
