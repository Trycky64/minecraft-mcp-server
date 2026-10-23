# Guide de préparation de release

> Mission 13 : candidate locale `2.1.0-beta.1` préparée avec preuves de tests Windows/Linux actuelles, non publiée. Le bridge autonome reste `0.1.0`. L'approbation du risque npm résiduel et de la publication reste à demander. Voir [MISSION12_MCP_RELEASE_REPORT.md](MISSION12_MCP_RELEASE_REPORT.md). Les paragraphes Mission 11 et antérieurs ci-dessous sont historiques.

> Mission 11 (2026-10-16) : une candidate locale **2.0.4** est préparée pour revue, avec checksums et manifeste sous `C:/Users/qperr/minecraft-mcp-test/release-candidate`. Le cœur peut entrer en revue bêta Windows/Linux x64 avec exclusions ; aucun `2.1.0-beta.1` n'a été appliqué, commité ou publié. Le GUI expérimental et ARM64 ne sont pas des garanties de cette candidate. Les risques npm résiduels exigent une décision explicite avant publication. Voir [MISSION11_FINAL_REPORT.md](MISSION11_FINAL_REPORT.md).

> Mise à jour Mission 10 : revue bêta du cœur MCP possible avec exclusions explicites (GUI expérimental, placement non démontré, ARM64 non validé). La candidate locale conserve la version source `2.0.4`, sans étiquette `2.1.0-beta.1`. Voir [MISSION10_FINAL_REPORT.md](MISSION10_FINAL_REPORT.md) avant toute décision de publication.

Ce guide décrit les opérations; il ne publie rien automatiquement.

## Versionnement

Inspecter `package.json`, l'historique et les tags avant de choisir une version. Utiliser SemVer; marquer `alpha`/`beta` tant que les chemins runtime ou plateformes cibles restent non validés. L'état actuel propose `2.1.0-beta.1` uniquement comme suggestion, sans modifier le manifeste.

## Contrôles

```sh
npm ci
npm run build
npm test
npm run lint
npm audit
npm audit --omit=dev
```

Puis Java 21 : `gradlew test build --no-daemon --max-workers=1` dans Processia et `gradlew -p neoforge-bridge test build --no-daemon --max-workers=1` à la racine Processia. Vérifier le JAR, les versions/plateformes, `git diff --check`, les secrets, les worlds/logs exclus et les preuves runtime sur une instance jetable.

## Artefacts et checksums

Préparer dans un répertoire candidate hors dépôt : tarball npm construit avec les fichiers réellement inclus, JAR bridge, JAR Processia s'il est nécessaire et licencié pour cette distribution, inventaire de dépendances, notes et matrice de compatibilité. Produire un SHA-256 pour chaque fichier et vérifier le checksum après copie. Ne jamais inclure credential, monde, configuration utilisateur ou journal privé.

## Installation et rollback

Documenter les versions requises, l'installation du mod côté serveur, la configuration loopback/credentials et le mode MCP. Pour rollback, désactiver le bridge dans la configuration du serveur de test, retirer le JAR ajouté et revenir à la version précédente sans effacer le monde. Sauvegarder avant toute action de publication.

## Publication (étapes humaines ultérieures)

Après approbation : revue du diff et du contenu empaqueté; commits cohérents; tag signé si le projet le requiert; brouillon GitHub; publication npm seulement si l'auteur/nom du package et l'accès sont explicitement confirmés; joindre checksums, notes et compatibilité. N'utiliser aucun push force. Vérifier les liens et artefacts téléchargés après publication.

La candidate locale reste réservée à la revue. Le cœur MCP peut être étudié pour une bêta avec exclusions explicites; ce guide ne constitue pas une autorisation de commit, tag ou publication.
