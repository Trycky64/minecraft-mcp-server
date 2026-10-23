# Mission 25 — Investigation du décodage `declare_recipes`

## Portée et verdict

Cette investigation est hors ligne. Aucun serveur Minecraft ou bridge n'a été contacté, aucun paquet historique n'a été récupéré et aucun codec de dépendance n'a été modifié. Les fixtures de test ci-dessous ont été fabriquées localement avec le schéma installé : elles ne sont pas une capture de l'incident.

**Verdict : PARTIAL.** Le nom du paquet, le schéma effectif, le chemin du décodeur et la signification des deux nombres de l'erreur sont établis. La cause exacte de l'incident historique et le champ précis où la lecture s'est décalée restent inconnus faute des octets originaux et de la métadonnée `field` associée à l'erreur.

## Versions établies

Versions installées dans ce working tree, vérifiées par `npm ls` et les versions du lockfile présent :

| Paquet | Version installée |
|---|---:|
| Node.js | 26.8.1 |
| npm | 11.19.0 |
| `mineflayer` | 4.39.0 |
| `minecraft-protocol` | 1.68.0 |
| `minecraft-data` | 3.117.0 |
| `prismarine-registry` | 1.11.0 |
| `prismarine-item` | 1.17.0 |
| `prismarine-nbt` | 2.7.0 |
| `protodef` | 1.19.0 |

`minecraft-data('1.21.1')` décrit Minecraft Java 1.21.1, data version 3955, protocole **767**. Il s'agit des versions présentes maintenant dans le checkout ; l'erreur historique ne comporte ni manifeste d'exécution ni capture permettant de prouver qu'elle a été produite avec ces versions exactes.

## Chemin de décodage constaté dans les sources locales

1. Mineflayer crée son client avec `minecraft-protocol`. En mode `version: false`, `minecraft-protocol` utilise d'abord sa version par défaut pour l'initialisation, puis son mécanisme `autoVersion` détecte la version annoncée par le serveur et sélectionne la version client avant le jeu. Mineflayer construit ensuite `bot.registry` à partir de la version annoncée par le ping.
2. `minecraft-protocol/src/client.js` sélectionne le décodeur avec `setSerializer(state)`. `minecraft-protocol/src/transforms/serializer.js` appelle `createProtocol(state, toClient, version, ...)` et construit `FullPacketParser` sur les données `minecraft-data` fusionnées avec les éventuels paquets personnalisés.
3. Dans le schéma PC 1.21.1, l'état `play`, direction `toClient`, associe le paquet `0x77` à `declare_recipes`. Le nom vient donc bien du schéma installé pour cette version et cet état ; ce n'est pas seulement un alias du moniteur.
4. La structure `packet_declare_recipes` commence par `recipes: []varint`. Chaque recette contient `name: string`, `type: varint` mappé sur les types vanilla connus, puis `data` choisi par un `switch` sur le type. Selon le type, `data` contient notamment les champs de groupe, ingrédients, résultats `Slot`, composants et paramètres de cuisson.
5. Protodef lit un `string` comme un compte (ici un VarInt) suivi d'octets UTF-8. `readPString` calcule `cursor + count`; si cette fin dépasse le buffer courant, il lève `PartialReadError` avant l'appel à `buffer.toString`.

Les données d'un `Slot` et ses composants appartiennent au schéma protocolaire `minecraft-data`/Protodef. `prismarine-item` intervient plus tard dans les représentations d'items Mineflayer ; il n'est pas la fonction qui lit le champ `string` signalé ici. `prismarine-nbt` peut être utilisé par certains types de composants NBT imbriqués, mais le message exact `Missing characters in string` provient de la primitive de chaîne Protodef.

## Interprétation du symptôme historique

Erreur rapportée :

```text
PartialReadError: Missing characters in string,
found size is 112028
expected size was 420784383
```

Dans `protodef/src/datatypes/utils.js`, ce texte est construit par `readPString` :

- `found size` est `buffer.length`, la taille du buffer de paquet remis au parseur à cet instant. Si la compression Minecraft a été activée, le buffer remis au parseur est après décompression ; ce nombre ne permet donc pas de connaître la taille compressée sur le réseau.
- `expected size` est `strEnd`, l'offset absolu de fin demandé dans ce buffer, et non une taille de chaîne valide ni une allocation effectuée.
- La longueur déclarée du texte est calculée depuis le VarInt précédent. La différence `expected size - cursor` est la longueur annoncée, mais `cursor` dépend de l'offset réel du champ, absent du message historique fourni.
- Le contrôle de dépassement intervient avant `buffer.toString`; ce chemin ne crée donc pas une chaîne de 420 Mo.

La valeur implique une longueur/délimitation incohérente au point de lecture, mais ne distingue pas à elle seule : VarInt mal interprété, décalage dû à un champ précédent, schéma/état/version incorrect, paquet tronqué, données personnalisées incompatibles ou anomalie antérieure.

Pour le schéma vanilla 1.21.1, `name` est la première chaîne de chaque entrée de recette. Il est donc un candidat si l'erreur survient au début d'une entrée. Le paquet contient toutefois d'autres chaînes après ce point. Sans buffer et chemin de champ Protodef, affirmer que le champ fautif était `name` serait une hypothèse.

## Reproductions hors ligne

Le test `tests/declare-recipes-protocol.test.ts` fabrique et parse des paquets avec les sérialiseur/désérialiseur installés. Les cas sont déterministes et bornés.

| Cas | Résultat observé | Preuve |
|---|---|---|
| Mapping du paquet 1.21.1 | Play clientbound `0x77` → `declare_recipes`; protocole 767 | Test du schéma installé |
| Recette vanilla synthétique de cuisson | Round-trip complet du nom, type, entrée, résultat et durée | Paquet construit via le sérialiseur 1.21.1 |
| Type inconnu `24` | Le mapper conserve `24`; le `switch` ne connaît pas sa forme et le parseur laisse le payload suivant non consommé | Fixture synthétique, `metadata.size` inférieur à la taille du buffer |
| Chaîne tronquée | `PartialReadError` dans `readPString` | Fixture synthétique de recette tronquée |
| VarInt de chaîne oversized | Message `found size is 7 expected size was 420784383`; aucun octet correspondant à la chaîne annoncée n'est fourni | Fixture synthétique, même valeur numérique rapportée mais **pas les octets de l'incident** |
| Octets surnuméraires | Le parseur expose une taille consommée inférieure au buffer | Fixture avec suffixe synthétique |
| Mauvais état ou version 1.21.4 | Le paquet n'est pas identifié comme `declare_recipes` du schéma Play 1.21.1 | Comparaison synthétique de schémas |

Le test de valeur oversized reproduit le texte et les valeurs numériques observés parce que le champ est délibérément fabriqué avec un VarInt correspondant. Cela confirme la sémantique du message, **pas** la cause ni les octets historiques.

## Hypothèses classées par preuve

| Hypothèse | Niveau | Motif / limite |
|---|---|---|
| Un champ chaîne a reçu un compte VarInt dont la fin calculée dépassait le buffer | Démontré par le texte exact et le code Protodef | Ne localise pas le champ ni l'origine du VarInt |
| Une désynchronisation antérieure a fait lire des octets non destinés à cette chaîne comme longueur | Plausible | Reproduit par construction avec un mauvais schéma ou une entrée mal alignée, mais aucune capture historique |
| Une recette personnalisée/non connue a produit une forme non représentée par le schéma vanilla | Plausible en présence d'extensions serveur | Fixture de type inconnu laisse un suffixe; aucune preuve que le serveur historique a envoyé un tel type |
| Le parseur a utilisé le mauvais état ou la mauvaise version | Plausible, non observé | La sélection dynamique est présente; l'état/version précis de l'incident n'a pas été enregistré |
| `prismarine-item` ou NBT est la source directe du message de chaîne | Écartée pour ce message | La chaîne exacte est construite par Protodef `readPString`; les composants peuvent néanmoins avoir leurs propres erreurs de décodage |
| NeoForge/Processia est la cause | Non démontré | Aucun paquet original ni exécution runtime autorisée pour cette mission |

## Comportement et sécurité du parseur

- Les erreurs de décodage restent propagées par `monitorProtocolDecode`; le moniteur conserve uniquement état, ID/nom si résolus, classe d'erreur, message fixe et date. Il ne garde ni buffer ni texte brut de l'erreur.
- Un échec `declare_recipes` ne marque pas, à lui seul, l'inventaire incomplet. Les mappings ne sont pas extraits par ce moniteur et aucune publication automatique d'un snapshot registry à partir de ce paquet n'a été trouvée dans le chemin TypeScript audité.
- Les snapshots runtime exigent toujours les liens d'epoch/provenance du `RuntimeRegistryService`; les données statiques ne deviennent pas des mappings runtime à cause d'un paquet de recettes.
- La vérification de chaîne dans `readPString` se produit avant la conversion en chaîne. En revanche, le schéma contient des arrays comptés par VarInt ; aucune limite applicative spécifique aux comptes de recipes dans ce paquet n'a été observée dans les sources de dépendances examinées. Le splitter `minecraft-protocol` conserve également les octets d'une trame jusqu'à ce que la longueur de trame annoncée soit disponible ; cette mission ne modifie pas ces bibliothèques.
- Protodef peut imprimer `e.stack` sur lecture partielle et peut imprimer le contenu décodé **et l'hex complet** lorsqu'un paquet parse sans consommer tous ses octets, si `noErrorLogging` est faux. Le fork passe désormais `hideErrors: true` au client Mineflayer. Ce réglage désactive ces sorties internes brutes ; le moniteur et le logger du fork continuent de traiter les erreurs sous forme filtrée.
- Le parseur peut conserver une valeur numérique inconnue pour un discriminator recipe et ne pas consommer le payload correspondant. C'est un indicateur de divergence, pas une preuve de compatibilité avec des serializers moddés : en présence de suffixe, la taille consommée doit être prise en compte comme anomalie, et la connexion Mineflayer peut échouer ultérieurement.

## Contrôle de révocation des erreurs bridge

Le statut HTTP authentique demeure prioritaire sur un code de statut déclaré. Un code structuré ne peut donc pas transformer HTTP 403 en erreur récupérable. Un cas contradictoire inverse (HTTP 408 non révocateur + métadonnée connue `authentication-refused` révocatrice) est maintenant classé `invalid-bridge-response` avec diagnostic fixe `bridge-http-status-code-mismatch`, ce qui invalide la session. Les tests couvrent également HTTP 403 accompagné d'un code déclaré non révocateur : la révocation reste exigée par le statut.

Cette règle ne fait pas confiance au texte distant pour autoriser une session. Une contradiction peut provoquer une révocation additionnelle, ce qui est le choix conservateur.

## Fichiers et changements de cette mission

- Ajout de tests offline dans `tests/declare-recipes-protocol.test.ts`.
- Test de non-régression de la contradiction code/statut dans `tests/bridge-adapters.test.ts`.
- `BotConnection` passe `hideErrors: true` au client Mineflayer ; un test vérifie l'option pour les créations et reconnexions.
- `normalizeBridgeError` traite fail-closed les métadonnées révocatrices contradictoires avec un statut HTTP non révocateur.
- Aucune dépendance, lockfile, version, codec de `node_modules`, configuration MCP, code Java ou asset PNG n'a été modifié pour cette mission.

## Données requises pour une conclusion runtime future

Sur un environnement explicitement autorisé et sans journaliser de contenu privé, collecter au moment de l'erreur : version Mineflayer / `client.version`, `client.state`, protocole numérique, `metadata.name` si le parseur l'a produit, `error.name`, `error.field`, taille du buffer et quelques compteurs/offsets filtrés. Ne pas conserver le payload complet ni le dump hex. Une capture d'octets doit être approuvée et expurgée séparément avant analyse.

Comparer alors la même trame au parseur exact de la version identifiée et à son schéma `play.toClient`. N'essayer un correctif de codec ou de compatibilité moddé qu'après avoir isolé le premier champ divergent et un test de régression minimisé.

## Validation de cette mission

Résultats finaux : build PASS, **300 tests AVA PASS** (8 cas ajoutés, 2 cas existants enrichis, 0 test ignoré, 0 échec), lint PASS sans avertissement et `git diff --check` PASS. La preuve demeure hors ligne ; la cause racine de l'incident historique reste non démontrée tant que ses octets/offsets ne sont pas disponibles.
