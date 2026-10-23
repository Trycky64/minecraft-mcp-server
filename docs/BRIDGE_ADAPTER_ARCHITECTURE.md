# Contrat commun des bridges MCP

## Portée

Le MCP expose maintenant un contrat TypeScript commun au-dessus des deux clients HTTP existants. Cette couche ne change pas les protocoles Java, les credentials, les headers, les endpoints ni les mécanismes d’authentification. Aucun handshake runtime n’est nécessaire pour construire les adaptateurs.

## Composants

- `BridgeAdapter` décrit le cycle de vie, la session, les opérations de lecture et les capacités prises en charge.
- `GenericNeoForgeBridgeAdapter` encapsule le protocole du mod NeoForge générique.
- `ProcessiaBridgeAdapter` encapsule le protocole spécialisé de Processia.
- `NeoForgeBridgeClient` conserve le transport HTTP, les validations de schéma, la lecture des credentials, les endpoints et les headers propres à chaque protocole.
- `NeoForgeBridgeIntegration` relie l’adaptateur choisi à `RuntimeRegistryService`, puis continue d’exposer les outils MCP existants.

Les adaptateurs refusent un client configuré pour l’autre mode. Leurs capacités sont des capacités du protocole implémenté ; elles ne prouvent pas qu’une capability existe sur un bloc donné. Pour le generic bridge, les capacités serveur réellement annoncées restent lues depuis `/v1/capabilities`. Le protocole Processia actuel n’a pas cet endpoint : ses capacités spécialisées sont donc limitées à celles effectivement implémentées par le client MCP.

## Capacités exposées

| Capacité | Generic NeoForge | Processia |
|---|---:|---:|
| `registry.read` | Oui | Oui, types connus du client |
| `registry.dynamic-index` | Oui | Non |
| `block.inspect` | Oui | Oui |
| `machine.inspect` / `machine.search` | Non | Oui |
| `recipes.inspect` | Non | Oui, types pris en charge par le protocole actuel |
| ItemHandler / EnergyStorage | Oui | Oui |
| FluidHandler | Oui | Non exposé par le bridge Processia actuel |
| Gaz Processia / HU Processia | Non | Non exposés actuellement |

Une capability absente échoue avec `capability-unsupported`; elle ne bascule pas vers l’autre protocole.

Les capacités de l’adaptateur décrivent ce que le client sait appeler, pas ce que le serveur garantit pour chaque bloc. La disponibilité réelle d’une capability sur une position reste une donnée de la réponse d’inspection. Les capacités de gaz et HU Processia ne sont pas annoncées tant qu’elles ne sont pas exposées par le protocole.

Dans `minecraft-get-capabilities`, `available` sur les entrées `neoforge.capability.*` signifie que l’inspection correspondante est utilisable avec l’adaptateur et la session courants. `serverAdvertised` contient uniquement la déclaration globale disponible via l’endpoint générique (ou `null` si le protocole ne la fournit pas). `availableAtPosition` reste `null` tant qu’aucune position précise n’a été inspectée. Une inspection de machine peut ensuite fournir les capabilities réellement présentes sur ce bloc.

États observables : `disabled` si le bridge est désactivé, `unconfigured` si activé mais invalide, `disconnected` avant authentification ou après révocation, `connecting` pendant un ou plusieurs handshakes, `authenticated` après handshake validé, `closing` pendant une fermeture réutilisable de session, `closed` après fermeture définitive de l’adaptateur. `closeSession()` et `clearSession()` ramènent un adaptateur ouvert à `disconnected`; `close()` le rend terminal. Une expiration distante n’est observable qu’à la réponse d’une requête et invalide alors la session.

## Session et epochs

Le contexte runtime est distingué par le tuple logique suivant :

```text
Minecraft endpoint + serverIdentity + Minecraft version
+ Mineflayer registryEpoch (si bot présent)
+ bridge sessionId + Java sourceRegistryEpoch
```

`registryEpoch` Mineflayer identifie la session active du bot et l’espace dans lequel les mappings sont publiés. `sourceRegistryEpoch` identifie la génération des registres fournie par le serveur Java. Le `sessionId` identifie l’authentification du client bridge. Ces identifiants ne sont pas interchangeables.

`adapter.sessionContext` expose l’identité côté bridge sous des noms explicites : session, serveur, endpoint, versions et `sourceRegistryEpoch`. L’epoch Mineflayer n’appartient pas à l’adaptateur ; `NeoForgeBridgeIntegration` et `RuntimeRegistryService` l’associent au contexte bridge authentifié et rejettent toute réponse tardive lorsque le contexte change.

Les lectures concurrentes sont permises. Pour des handshakes concurrents, le dernier démarré est le seul autorisé à établir la session; les précédents échouent comme expirés, même si leur réponse arrive plus tard. `clearSession()`, `closeSession()` et `close()` invalident les générations d’opérations en vol. Une lecture commencée avant une révocation ou un changement de session échoue au lieu de retourner sa réponse. Le `close()` terminal marque l’adaptateur fermé immédiatement; une fermeture réutilisable bloque les nouveaux appels et expose l’état `closing`.

À chaque reconnexion Mineflayer, changement de cible ou changement de version, `RuntimeRegistryService` invalide le contexte précédent. L’intégration établit une nouvelle session bridge puis lie les données Java à l’epoch runtime courant. Les réponses de chaque page sont revérifiées contre la session, l’identité et l’epoch avant publication. En mode bridge seul, l’epoch runtime est construit à partir de l’identité serveur et de l’epoch Java ; aucun epoch Mineflayer n’est inventé.

La fermeture efface le contexte lié. Une session bridge qui a expiré ou dont l’identité/génération ne concorde plus ne peut pas conserver ses snapshots dans le contexte actif.

## Erreurs communes

`BridgeAdapterError.code` normalise les erreurs observables en catégories stables : bridge désactivé ou indisponible, authentification refusée, identité incorrecte, session expirée, epoch périmé, capability non supportée, timeout, configuration invalide, réponse invalide ou erreur de requête. `message` conserve les identifiants de diagnostic sûrs déjà utilisés par les outils; les credentials connus et les champs Authorization sont masqués. Les réponses arbitraires ne deviennent pas des messages d’erreur publics. `invalidatesSession` préserve la distinction entre erreur de requête non révocatoire et erreur qui invalide la session.

| Catégorie | Révoque la session locale | Politique |
|---|---:|---|
| Capability non supportée | Non | Refus local avant tout appel HTTP. |
| Requête localement invalide | Non | Refus avant réseau; session conservée. |
| Erreur HTTP fonctionnelle hors 401/403/409 | Non | Préserve la session; l’opération échoue explicitement. |
| 401, 403 ou 409 | Oui | Authentification/session potentiellement invalide. |
| Timeout client, erreur réseau, identité, epoch, JSON ou schéma invalide | Oui | Échec fermé; aucun résultat n’est publié. |
| Erreur HTTP 408 ou 5xx explicite | Non, sauf statut révocatoire | Réponse fonctionnelle du serveur; elle ne prouve pas à elle seule que la session est révoquée. |
| Erreur inconnue ou signal `invalidatesSession` mal typé | Oui | Valeur par défaut conservatrice. |
| Bridge désactivé/mal configuré | Sans session | Aucun appel; l’état reste `disabled` ou `unconfigured`. |

Une erreur de requête ne déclenche pas un retry automatique d’une opération de lecture. Les opérations du contrat sont en lecture seule ; la réauthentification éventuelle reste une action explicite de l’intégration et recrée le client depuis la configuration propre à son mode.

## Frontières de sécurité

- Le generic adapter ne lit que les variables et fichier de credentials `MINECRAFT_MCP_*`.
- Le Processia adapter ne lit que la configuration `PROCESSIA_*`.
- Un client de credentials generic ne peut pas être encapsulé par l’adaptateur Processia, et inversement.
- Les protections loopback, les IDs de requête, les sessions authentifiées, les limites, les timeouts et la validation des réponses restent dans les clients et les bridges Java existants.
- Cette abstraction ne démarre pas les bridges et n’ouvre aucun endpoint.

## Étapes de migration

1. Les outils Registry et le repli automatique utilisent déjà `adapter.supports(...)` et l’état de l’adaptateur pour sélectionner les capacités et le mode.
2. `NeoForgeBridgeIntegration.client` reste exposé pour compatibilité avec les appels existants; la migration des consommateurs tiers peut se faire séparément.
3. Ajouter de nouvelles capacités uniquement après implémentation et tests du bridge Java correspondant.
4. Ne pas fusionner les protocoles Java avant une migration indépendante, versionnée et compatible.

Les deux bridges Java restent séparés parce qu’ils ont des schémas de credentials, headers, endpoints et domaines fonctionnels différents. Cette mission standardise uniquement le contrat TypeScript et conserve leur authentification propre.
