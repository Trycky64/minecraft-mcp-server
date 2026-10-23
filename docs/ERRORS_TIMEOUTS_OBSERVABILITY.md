# Erreurs, timeouts et diagnostics

Cette note décrit les comportements présents dans le fork. Les tests de cette mission sont hors ligne : ils ne valident pas la disponibilité d'un serveur Minecraft ou d'un bridge réel.

## Erreurs et politique de session

Les erreurs bridge exposent un code stable `BridgeErrorCode`. `invalidatesSession` est dérivé du code, jamais décidé par un texte de diagnostic ou un indicateur fourni par une réponse distante. Les anciens constructeurs qui acceptent encore un argument `invalidatesSession` le gardent pour compatibilité de source, mais cet argument ne peut plus affaiblir la politique.

| Code public | Signification | Session | Retry automatique | Temporaire | Journal/contexte sûr |
|---|---|---|---|---|---|
| `invalid-request` | Paramètre local ou requête refusée (HTTP 400/422) | Conservée | Non | Non | code et opération |
| `resource-not-found` | Ressource ciblée absente (HTTP 404 ou code reconnu) | Conservée | Non | Non | code, jamais le payload |
| `chunk-not-loaded` | Chunk non chargé, donc inspection impossible | Conservée | Non | Potentiellement | code seulement |
| `capability-unsupported` | Fonction non offerte par l'adaptateur (405/501 inclus) | Conservée | Non | Non | adaptateur et capacité |
| `bridge-disabled` / `bridge-configuration-invalid` | Bridge désactivé ou configuration invalide | Conservée | Non | Non | code, aucune valeur de credential |
| `bridge-http-timeout` | Réponse HTTP 408 effectivement reçue | Conservée | Non | Oui | code `bridge-http-timeout` |
| `bridge-rate-limited` | Réponse HTTP 429 effectivement reçue | Conservée | Non | Oui | code `bridge-rate-limited` |
| `bridge-timeout` | Timeout local de transport ou lecture interrompue | Révoquée | Non | Oui | code seulement |
| `bridge-unavailable` | Erreur HTTP 5xx ou service inaccessible | Révoquée (fail closed) | Non | Oui | code seulement |
| `authentication-refused` | HTTP 401/403 ou authentification refusée | Révoquée | Non | Définitive jusqu'à correction | code seulement |
| `session-expired` | Session absente/expirée ou HTTP 409/410 | Révoquée | Non | Oui | code seulement |
| `server-identity-mismatch` | Endpoint, identité ou version incohérents | Révoquée | Non | Non sans nouvelle liaison vérifiée | code seulement |
| `stale-registry-epoch` | Epoch ou génération réellement périmé(e) | Révoquée | Non | Non pour cette génération | code seulement |
| `invalid-bridge-response` | Réponse invalide, incohérente ou incomplète | Révoquée | Non | Non sans nouvelle réponse valide | code seulement |
| `operation-superseded` | Résultat remplacé par une opération plus récente | Conservée | Sans objet | Oui | code seulement |
| `bridge-request-failed` | Erreur inconnue ou non classable | Révoquée | Non | Inconnue | code seulement |

HTTP 408 est distingué d'un timeout local : le premier prouve qu'une réponse HTTP a été reçue et ne révoque pas à lui seul l'authentification ; le second laisse l'issue de la requête inconnue, invalide le contexte local et est fail closed. HTTP 429 est également une réponse explicite de limitation et ne révoque pas la session. Aucun de ces cas ne déclenche un retry automatique.

Ces règles 408/429/4xx supposent une enveloppe de réponse valide, avec le bon identifiant de corrélation, un JSON borné et le schéma attendu. Un corps malformé, un identifiant de corrélation absent/incorrect ou un échec de lecture reste `invalid-bridge-response` ou `bridge-timeout` et fail closed. Les codes de diagnostic contenus dans les corps HTTP ne sont réémis que s'ils figurent dans la liste historique explicite; sinon seul le code canonique est publié.

Les erreurs de gameplay conservent leurs messages existants, dont les marqueurs d'incertitude tels que `move-timeout-result-uncertain`, `dig-timeout-result-uncertain-no-retry` et `window-click-timeout-result-uncertain-no-retry`. Un timeout après envoi d'une action non idempotente ne déclenche pas de répétition automatique. Le résultat doit être réobservé avant une nouvelle demande.

Les erreurs d'une opération ancienne ne peuvent révoquer une session plus récente : les adaptateurs vérifient génération et identifiant de session avant l'invalidation ; l'intégration bridge revérifie aussi l'identité de la session avant de la retirer. Une actualisation remplacée reçoit désormais `operation-superseded`, distinct d'un epoch réellement périmé.

## Timeouts et bornes observés

| Chemin | Valeur constatée dans le code |
|---|---|
| Requête bridge HTTP et lecture de réponse | `PROCESSIA_BRIDGE_TIMEOUT_MS` ou `MINECRAFT_MCP_BRIDGE_TIMEOUT_MS`, défaut 3000 ms, plage acceptée 100–15000 ms, par requête |
| Requête GUI harness | `PROCESSIA_GUI_TIMEOUT_MS`, défaut 5000 ms, plage 100–15000 ms, par requête |
| Attente initiale Mineflayer dans le démarrage `auto` | 5000 ms |
| Attente de connexion lors d'un outil après déconnexion | délai de reconnexion 2000 ms + attente maximale 5000 ms; sondage toutes les 100 ms |
| Attente de fenêtre | défaut 3000 ms, maximum 10000 ms |
| Clic de slot | défaut 3000 ms, maximum 10000 ms; sans retry après incertitude |
| `move-to-position` | défaut 15000 ms, maximum 30000 ms |
| `dig-block`, pathfinding et minage | défaut 15000 ms, maximum 30000 ms; pas de retry après timeout incertain |
| `place-block` pathfinding | défaut 15000 ms, maximum 30000 ms; aucun paquet de placement après timeout de pathfinding |
| `craft-item`, attente de chaque `bot.craft` | 15000 ms par craft; maximum 16 opérations, sans deadline globale distincte |
| `smelt-item` attente de sortie | défaut 60000 ms, maximum 120000 ms |
| GUI `gui-wait-for` | défaut 3000 ms, maximum 10000 ms |
| GUI `gui-run-e2e` | défaut 30000 ms, maximum 60000 ms |
| Fermeture Mineflayer | arrêt borné après 1000 ms si l'événement de fin ne survient pas |
| Fermeture bridge | requête de fermeture soumise au timeout HTTP bridge, 100–15000 ms |

Une durée de requête bridge est un délai par appel HTTP. Le rafraîchissement paginé est une séquence de plusieurs appels : il n'a pas de deadline globale distincte. Pour le crafting, chaque appel Mineflayer est borné à 15 s; à la limite maximale actuelle de 16 opérations, le temps théorique cumulé atteint 240 s. Si un appel expire, son résultat est déclaré incertain, il n'est pas répété et un verrou par bot empêche une seconde opération de crafting jusqu'à ce que la promesse tardive se termine ou que ce bot soit remplacé après reconnexion. Les opérations de gameplay gardent leurs autres limites propres.

## Logs et masquage

Les logs restent locaux sur `stderr`. `log()` conserve le format historique, mais réduit les contrôles à des espaces, limite le texte à 2000 caractères et masque les valeurs de champs `Authorization`, `Bearer`, secret, token, password, credential et identifiants de session, ainsi que les identifiants dans l'autorité d'une URL. `logEvent()` produit une ligne JSON locale avec horodatage, sévérité, composant, opération, correlation ID UUID et uniquement les champs facultatifs allowlistés : code, durée, issue, mode, type d'adaptateur et génération numérique de session. Aucun identifiant de session authentifiée, inventaire, payload ou header n'est accepté par son schéma de champs.

Les erreurs de démarrage et erreurs fatales de processus sont normalisées en code public avant journalisation. Les logs Mineflayer ne recopient plus les motifs de kick ni les messages de protocole contrôlés par le serveur. Le moniteur de décodage conserve état, nom de paquet et classe d'erreur, mais remplace le message du décodeur par un diagnostic fixe; le paquet brut n'est jamais conservé.

Les réponses d'erreur MCP passent par le même nettoyage des secrets et caractères de contrôle. Les outils bridge renvoient un code stable plutôt que le texte d'une exception. `bridge-status` fournit le dernier code d'erreur sûr, l'état/configuration et l'adaptateur; `registry-status` ajoute une vue réduite de ces diagnostics. `minecraft-get-capabilities` distingue support de l'adaptateur, capacités annoncées par le serveur et disponibilité à une position, cette dernière restant inconnue sans interrogation.

`ToolFactory.createErrorResponse()` conserve son texte historique et ajoute dans `_meta.diagnostic` un code/catégorie, les indicateurs `retryable`, `temporary` et `sessionInvalidated` (null lorsqu'aucun contexte bridge n'est concerné). `retryable` signifie qu'une nouvelle tentative explicite peut être raisonnable après les vérifications indiquées; aucun retry n'est lancé par le MCP. Les catégories générales incluent `invalid-input`, `minecraft-session-unavailable`, `capability-unsupported`, `resource-unavailable`, `operation-timeout` et `operation-failed`. Les outils bridge qui retournent déjà leur format JSON gardent leur forme et publient leur code stable existant.

Le champ `bridge-status.lastError` est un état courant de diagnostic : il conserve un code public canonique ou quelques identifiants protocoliques historiques explicitement autorisés (`bridge-unauthorized`, `bridge-forbidden`, `bridge-chunk_not_loaded`, `bridge-session_expired`); toute autre valeur issue du corps HTTP est remplacée par le code canonique. Une opération bridge réussie le remet à null. Il ne constitue pas un historique d'audit.

## Compatibilité et limites

- Les noms des outils et les formats normaux de leurs réponses restent inchangés; `registry-status` reçoit seulement le champ additif `bridgeDiagnostic`.
- Les codes de bridge existants restent disponibles. Les codes additifs sont `bridge-http-timeout`, `bridge-rate-limited`, `invalid-request`, `resource-not-found`, `chunk-not-loaded` et `operation-superseded`.
- Les 60 outils enregistrés sont vérifiés par les tests existants.
- Le comportement protocolique `declare_recipes` n'est pas modifié.
- L'ID brut 1373 n'est pas interprété par cette mission.
- Aucun serveur réel n'a été contacté. La politique avec un bridge Java actif, les timeouts du runtime HTTP réel, les délais d'arrêt OS et les comportements Minecraft après timeout restent à valider ultérieurement.
- Les erreurs de gameplay préexistantes ne sont pas toutes converties en une nouvelle classe TypeScript commune afin de préserver leurs contrats publics. Les codes bridge, la validation d'entrée, les résultats d'action incertains et les erreurs internes sont documentés séparément.
- Les résolutions de registres `resolved`, `unresolved`, `unavailable` et `ambiguous` sont des résultats métier structurés, pas des erreurs MCP. Elles gardent leurs propres codes/reasons et leur provenance; cette mission ne transforme pas un identifiant non résolu en erreur de transport.
