# Architecture générique des menus Minecraft moddés

Cette architecture concerne le MCP universel. Les contrats Processia sont une extension facultative ; le cœur fonctionne avec le seul fournisseur vanilla versionné et sans le mod Processia.

## Chaîne de données

1. **Observation protocolaire** : `open_window` / `open_horse_window`, `window_items`, `set_slot`, `craft_progress_bar` et `close_window` sont suivis dans `InventoryActionConfirmationTracker`, attaché au client Mineflayer. Le paquet générique `packet` est émis par `minecraft-protocol` avant l'événement nommé consommé par Mineflayer.
2. **Identité** : `resolveMenuIdentity` garde l'ID numérique brut. Une clé namespacée moddé est acceptée uniquement si un mapping menu courant et authentifié correspond exactement au serveur, à la session bridge, à la version et aux epochs capturés à l'ouverture. Une identité vanilla versionnée est étiquetée `version-static`, jamais comme preuve runtime.
3. **Disposition** : `MenuLayoutRegistry` ne résout que les contrats de slots. Il ne peut pas établir l'identité du menu. Il applique les fournisseurs compatibles avec la version, l'identité et le nombre de slots observé ; le modèle Mineflayer doit également concorder quand il existe.
4. **Interaction** : les clics utilisent exclusivement le modèle Mineflayer actif et un snapshot complet et frais. Les fenêtres visibles uniquement en raw sont en lecture seule. Les shift-clicks restent refusés si la disposition n'est pas connue.
5. **Confirmation** : le protocole de conteneur n'associe pas un changement de slot à un clic par un identifiant de corrélation. Une concordance d'état est donc rapportée comme observation serveur, pas comme preuve de causalité.

## Contrat de fournisseur

Un `MenuLayoutProvider` possède un identifiant stable et peut fournir des contrats contenant :

- la clé namespacée du menu et les versions Minecraft exactes couvertes ;
- la source documentaire ou logicielle du contrat ;
- le nombre total de slots attendu ;
- les plages décrites pour la zone menu, l'inventaire joueur et la hotbar ;
- les rôles de slots documentés et les contrôles, toujours non exécutables par les outils génériques.

Les plages doivent être entières, disjointes et tenir dans le nombre total de slots. Un contrat doit correspondre au nombre de slots effectivement observé. Une plage d'inventaire Mineflayer incompatible invalide le contrat. Aucun fournisseur n'a de priorité lui permettant d'écraser un autre : des dispositions différentes pour la même identité/version donnent `conflict`. Les identités moddées statiques ou non autoritatives ne peuvent pas activer un contrat. Le registre est limité à 16 fournisseurs et 128 contrats applicables par fournisseur.

Le registre distingue `known`, `unknown`, `incompatible` et `conflict`. Les propriétés synchronisées utilisent un mécanisme distinct : sans sémantique unique fournie par un fournisseur correspondant, seul l'index et la valeur bruts sont exposés.

## Fournisseurs

- **Vanilla** : adaptateur de `prismarine-windows` chargé pour la version Mineflayer. La clé et l'ID numérique de type doivent concorder ; le nombre de slots et la plage du modèle sont ensuite vérifiés.
- **Mods tiers** : fournisseurs injectables décrivant uniquement les dispositions explicitement documentées. La découverte d'une clé `namespace:path` par le bridge ne suffit pas à déduire les rôles des slots.
- **Processia** : `processia-menu-layout-provider.ts`, ajouté explicitement lors de la composition actuelle du serveur. Il contient les 22 contrats transcrits de `ModMenus`, `MachineLayout` et `WorkshopMenu`, limités à Minecraft 1.21.1. Il ne s'active qu'avec l'identité Processia runtime authentifiée et le nombre/plage de slots concordants. Aucun autre mod ne réutilise ces contrats.

Un déploiement sans extension Processia peut appeler `registerWindowTools` sans ce fournisseur ; vanilla et les fournisseurs tiers restent indépendants.

## Observation raw-only

Si un paquet d'ouverture/contenu est décodé mais qu'aucun objet Mineflayer `Window` n'est disponible, `inspect-open-window` peut retourner `raw-only-window-observed`. Les champs incluent l'ID et la génération de fenêtre, le type numérique de menu, l'identité autoritative éventuelle, le titre comme donnée d'affichage non fiable, le `stateId`, le compte de slots transmis, les IDs numériques bruts d'items, les quantités, les comptes/types de composants, le curseur, les propriétés synchronisées et le binding de session/epochs capturé à l'ouverture.

L'observation est bornée à 256 slots, au titre sérialisé de 1024 caractères et à 32 identifiants de composants par slot. Les payloads arbitraires des composants sont omis. L'ID d'item brut reste non résolu par cette vue. Le statut décrit un paquet complet `window_items` observé ; lorsque la disposition est inconnue, il ne prouve pas à lui seul que la taille correspond à une définition serveur attendue.

Cette vue ne construit/injecte pas de `Window`, n'envoie pas de clic et ne confirme pas d'action. Un paquet qui échoue au décodage Protodef n'atteint pas l'événement `packet` et ne peut pas être récupéré par ce chemin.

## Limites Mineflayer

Dans Mineflayer 4.39.0, l'écouteur `open_window` appelle `prismarine-windows.createWindow(windowId, inventoryType, title, packet.slotCount)`. En 1.21.1, `open_window` ne contient pas `slotCount`. `prismarine-windows` retourne `null` pour un type inconnu sans ce nombre ; l'initialisation Mineflayer attend ensuite un objet fenêtre et peut échouer avant `windowOpen`. L'observateur raw est attaché à l'événement générique `packet`, émis avant l'événement nommé, et peut conserver les paquets décodés déjà reçus. Il ne peut pas corriger un échec du décodeur ni rendre le menu interactif.

Il n'y a pas de fallback par nombre de slots pour inventer la plage d'inventaire joueur ou la sémantique des shift-clicks. Le client graphique instrumenté demeure la voie de test du rendu et des interactions d'interface réelles.

## Compatibilité et sécurité

- Les outils et leurs noms existants sont conservés ; aucun outil MCP supplémentaire n'est enregistré.
- La génération locale est distincte de l'ID de fenêtre réutilisable et des epochs serveur.
- Une fenêtre conserve le binding runtime observé à son ouverture. Un changement de serveur, session bridge, registry epoch ou runtime epoch invalide toute résolution moddé pour cette ancienne observation.
- Les clics simples ne partent jamais depuis raw-only. Les interactions disponibles depuis un modèle Mineflayer restent soumises aux validations existantes de fenêtre, epoch, génération, plage et synchronisation.
- Les IDs inconnus restent numériques et explicitement non résolus.

## Validation

Les tests sont des fixtures hors ligne portant sur le protocole 767, des menus vanilla et les namespaces fictifs `examplemod:*` et `anothermod:*`. Aucun test décrit ici ne constitue une validation runtime Minecraft. Une validation future devra tester un serveur vanilla et un serveur NeoForge avec un menu tiers réel, observer l'échec éventuel de construction Mineflayer, et vérifier que l'inspection raw-only ne produit aucune écriture.
