# Mission 18 — Premières interactions Survie complètes

Date d'exécution : 2026-10-20. Dépôt utilisé : `C:/Users/qperr/processia-mcp-server`, branche `feature/processia-integration`.

## Cible et méthode

- La configuration projet `C:/Users/qperr/Processia/.codex/config.toml` désigne le fork local (`C:/Users/qperr/processia-mcp-server/dist/main.js`) avec `--host 127.0.0.1 --port 25665 --username CodexBot`. Elle n'a pas été modifiée.
- Le client MCP de cette validation a été lancé directement depuis ce fork avec ces mêmes arguments. Aucun connecteur Minecraft global n'a été appelé.
- Serveur déjà actif : PID 23780, listener `127.0.0.1:25665`, Minecraft 1.21.1 / protocole 767 / NeoForge 21.1.259. Profil : `C:/Users/qperr/minecraft-mcp-test/neoforge-processia`; monde `world`, fichier `world/level.dat` présent. Le serveur n'a pas été redémarré. Le port 25565 n'a pas été consulté.
- `detect-gamemode` a confirmé `survival`. L'inventaire initial était une pile inconnue `rawNumericId=1373`, quantité 1, slot 36. Cette pile est restée présente et intacte jusqu'à la fin.
- Le bot a été déconnecté proprement à la fin de la session MCP. Le serveur et son listener sont restés actifs.

## Parcours réellement exécuté

| Étape | Résultat et preuve MCP |
|---|---|
| Observer | `get-block-info` a signalé le bloc naturel `(18,102,-14)` comme candidat statique `minecraft:grass_block`, state ID brut 9, avec `canDigBlock=true` et `canSeeBlock=true`. Les outils signalent explicitement que ce mapping reste statique, car le bridge n'est pas authentifié. |
| Se déplacer | `move-to-position` a déplacé CodexBot de `(21,104,-15)` à `(20,104,-15)`, puis à `(18,103,-14)`. `get-position` a confirmé les coordonnées. Un autre chemin borné a expiré après 15 s ; le bot s'est arrêté à `(20,100,-17)`, position relue avant toute nouvelle action. |
| Miner | `dig-block` sur le grass block a confirmé state ID 9 → 0. Un essai antérieur sur des blocs du tronc obstrués a été refusé sans envoyer le minage ; l'état des cibles et l'inventaire sont restés inchangés. Une feuille naturelle a été minée (state 240 → 0) pour ouvrir le couvert ; aucun drop n'a été constaté. |
| Drop et ramassage | Après minage du grass block, Mineflayer a observé une entité de drop `dirt`, ID brut 28, quantité 1, entité 1887. La première réponse de minage n'a pas prétendu que l'objet était déjà collecté. La lecture ultérieure de `list-inventory` a confirmé `dirt x1`, slot 37. Après minage de la bûche, le drop `oak_log`, ID brut 132, quantité 1, entité 1926 a été observé ; `find-entity` en a exposé la position et le stack brut. Un déplacement normal à `(21,100,-16)` a été suivi par `list-inventory`, qui a confirmé `oak_log x1`, slot 38. |
| Crafter | `can-craft` et `get-recipe` ont identifié la recette vanilla `oak_log x1 → oak_planks x4`. `craft-item` a été accepté, puis l'inventaire a confirmé `oak_planks x4` (ID brut 36). Cela démontre une transformation réelle acceptée et synchronisée par le serveur, pas seulement la recette statique. |
| Placer | Après équipement de la planche obtenue, `place-block` a placé une planche dans l'emplacement naturel du tronc miné `(22,100,-16)`, sur un bloc de dirt observé en support. `get-block-info` a confirmé ensuite `oak_planks`, state ID 15, block ID brut 13 ; l'inventaire relu après synchronisation a confirmé les planches réduites de 4 à 3. |
| Conteneur | `inspect-open-window` a retourné `no-window`. La recherche bornée de coffres chargés a été `inconclusive`, car elle repose sur des state IDs statiques non vérifiés. Aucun coffre préexistant n'a été ouvert ou inspecté. |

État final MCP : mode Survie, endpoint `127.0.0.1:25665`, position relue `(21,100,-16)`. L'inventaire final lu par MCP contenait `unknown x1` (ID 1373, slot 36), `dirt x1` (ID brut 28, slot 37) et `oak_planks x3` (ID brut 36, slot 38). L'action a laissé un bloc d'herbe miné et une feuille naturelle retirée ; le trou de tronc a été remplacé par une planche. Aucune construction n'a été touchée et aucune ressource n'a été injectée.

Les noms des blocs et items vanilla ainsi que les IDs affichés ci-dessus sont des observations Mineflayer / candidats `minecraft-data`, pas des correspondances NeoForge autoritatives. Les confirmations importantes du parcours sont les mises à jour du bloc, du drop, de l'inventaire, l'acceptation du craft serveur et la mise à jour après placement. Le bridge reste nécessaire pour élever la confiance des mappings.

## Audit et corrections du fork

- `dig-block` utilise temporairement une case de hotbar vide afin de ne jamais employer l'objet tenu inconnu ; le slot sélectionné est restauré dans un `finally`. L'action renvoie maintenant séparément l'état miné, les entités de drops observées et les augmentations d'inventaire. Un bloc passé à air ne signifie plus à lui seul que le drop a été produit ou collecté.
- `get-block-info` expose aussi la distance, `canDigBlock`, `canSeeBlock` et `diggable` pour diagnostiquer une cible avant action. Après pathfinding, `dig-block` renvoie le motif précis d'un refus et ne mine pas une cible devenue obstruée ou hors de portée.
- Le clic de menu attend la résolution du chemin de synchronisation/confirmation de `Mineflayer.clickWindow` et distingue ce clic d'un transfert observé par delta de slot ou curseur. Un clic sans delta n'est pas présenté comme un transfert réussi.
- `interact-block` restaure le slot hotbar dans un `finally`, y compris si l'état de l'objet tenu change pendant l'interaction. `find-entity` inclut les coordonnées et l'ID brut d'un stack tombé, sans traiter son nom Mineflayer comme une identité autoritative.
- `place-block` relit la cible et le bloc de support après un déplacement, et refuse d'envoyer un paquet si la cible a changé. Après une tentative ambiguë, il n'envoie pas de retry automatique.

Tests de régression ajoutés pour le slot inconnu préservé pendant le minage, la distinction bloc/drop/ramassage, la restauration du slot, le delta réel des clics, les stacks tombés, et la cible qui change pendant un pathfinding de placement.

## Bridge, recettes Processia et protocole

- Le journal du profil confirme le chargement des mods `minecraft_mcp_bridge-0.1.0.jar` et `processia-0.1.0.jar` sur NeoForge 21.1.259, mais affiche pour chacun `Diagnostic bridge is disabled (default)`.
- `bridge-status` a renvoyé `enabled=false`, `configured=false`, `connected=false`, `authenticated=false`, `bridgeAvailable=false`, `secretConfigured=false`. Les outils Processia ont renvoyé `bridge-disabled` ; aucun registre Processia, aucune machine ni recette Processia n'a pu être interrogé. Le serveur n'a pas été reconfiguré ni redémarré.
- `registry-resolve` a renvoyé `processia:crusher` et l'ID item 1373 en `unresolved / mapping-not-observed`. Aucune identité n'a été inventée pour la pile inconnue.
- `registry-status` a signalé `declare_recipes` (clientbound packet 119, protocole 767) avec `PartialReadError`: `Missing characters in string, found size is 112028 expected size was 420784383`. Le snapshot d'inventaire est resté `complete`, sans erreur `window_items`/`set_slot`. La connexion a continué à fournir des lectures et actions vanilla. Le codec et les dépendances n'ont pas été changés.
- Un changement d'`registryEpoch` a été observé pendant l'exécution MCP (`session:5ecde818-7b68-4179-8ce8-0df4c44785df` puis `session:6b3c4c1b-9b03-4a9d-b84c-d68fe3bc5e58`). Le contexte final était connecté au même endpoint/version, avec position et inventaire conservés. La cause exacte du renouvellement de contexte n'a pas été prouvée ; aucun snapshot bridge n'était injecté.

Pour une prochaine activation, procédure sûre proposée : arrêter normalement uniquement ce profil isolé, faire une copie cohérente de `neoforge-processia/world` vers un chemin de sauvegarde sous `C:/Users/qperr/minecraft-mcp-test`, configurer l'activation et un secret éphémère uniquement dans le profil isolé avec ACL restreinte, injecter le secret par variable d'environnement du processus MCP, puis redémarrer la même installation et vérifier `level.dat`, le monde et l'identité/epoch du bridge. Aucune de ces opérations n'a été exécutée pendant cette mission.

## Résultats qualité

- `npm run build` : PASS.
- `npm test` : PASS, **250 tests** (résultat final après les derniers tests ci-dessous).
- `npm run lint` : PASS.
- `git diff --check` : PASS ; Git affiche uniquement des avertissements de conversion de fins de lignes LF/CRLF sur des fichiers déjà modifiés.
- Aucun changement de dépendance, lockfile, version, PNG, configuration MCP ou dépôt Processia. Aucun commit ou push.

## Verdict

**PARTIAL — première chaîne de gameplay vanilla confirmée en Survie : observer → déplacement → minage → drop → ramassage → craft → placement.** Le conteneur n'a pas pu être validé faute de cible chargée et fiable. Les machines et recettes Processia restent bloquées par le bridge désactivé et par l'absence de mappings runtime autoritatifs. `declare_recipes` reste une anomalie reproductible mais n'a pas bloqué cette chaîne vanilla.

Prochaine étape : préparer la sauvegarde du même monde, activer/authentifier le bridge dans le profil isolé (avec redémarrage contrôlé si nécessaire), puis vérifier les registres Processia avant de rechercher une machine déjà présente. Ne pas fabriquer une machine ni injecter des ressources pour prétendre valider V0.2.
