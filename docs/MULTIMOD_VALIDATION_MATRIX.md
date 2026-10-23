# Matrice runtime multi-mods

Statuts : `PASS` = observé et conforme; `FAIL` = observé non conforme; `BLOCKED` = prérequis manquant ou contrôle insuffisant; `NOT_RUN` = pas exécuté; `UNSUPPORTED` = non pris en charge par le protocole/adaptateur. Chaque ligne débute `NOT_RUN`; un test hors ligne ne la change pas.

## Profils

| ID | Configuration indépendante | Dépendance à Processia |
|---|---|---|
| A — Vanilla | Minecraft 1.21.1, sans mod | Aucune |
| B — NeoForge tiers | NeoForge 21.1.259, bridge générique, mod tiers avec menu; sélection/compatibilité/licence à approuver avant téléchargement | Aucune |
| C — Processia facultatif | NeoForge 21.1.259, bridge générique et Processia | Scénario complémentaire seulement |

## Scénarios et preuves

| Profil | Scénario | Preuve minimale | Statut Mission 29 |
|---|---|---|---|
| A | Connexion | version/protocole/identité, session et epoch assainis | NOT_RUN |
| A | Inventaire | snapshot complet et résultat de mise à jour observé | NOT_RUN |
| A | Menu vanilla | type numérique, Window Mineflayer, slots, stateId, fermeture | NOT_RUN |
| A | Conteneur | état serveur avant/après clic sans conclure à une causalité non corrélée | NOT_RUN |
| B | Registres | namespaces et pages avec provenance/complétude | NOT_RUN |
| B | Menu tiers | identité namespace autoritative si fournie; sinon type numérique seulement | NOT_RUN |
| B | Type inconnu | erreur Mineflayer conservée; session réévaluée après incident | NOT_RUN |
| B | Raw-only | seuls paquets décodés, compte/IDs bruts, propriétés bornées | NOT_RUN |
| B | Interaction | jamais déduite d'une observation raw-only | NOT_RUN |
| C | Menu Processia | fournisseur connu lié à identité, version, session et epochs | NOT_RUN |
| C | Disposition | nombre/plages de slots comparés aux observations courantes | NOT_RUN |

## Enveloppe de preuve par scénario

```json
{
  "status": "NOT_RUN",
  "profile": "neoforge-third-party",
  "minecraftVersion": null,
  "protocolVersion": null,
  "neoForgeVersion": null,
  "loadedModIds": [],
  "serverIdentity": null,
  "minecraftEndpoint": null,
  "mineflayerSessionId": null,
  "runtimeEpoch": null,
  "bridgeSessionId": null,
  "registryEpoch": null,
  "menuNumericType": null,
  "menuNamespacedId": null,
  "menuIdentityProvenance": null,
  "mineflayerWindowConstructed": null,
  "rawOnlyAvailable": null,
  "observedSlotCount": null,
  "snapshotComplete": null,
  "stateId": null,
  "synchronizedPropertyCount": null,
  "safeErrorCodes": []
}
```

Ne pas stocker le bearer secret, les paquets réseau bruts, le chat, les noms de joueurs autres que le bot de test, les payloads de composants, ni un screenshot dans cette matrice. Les artefacts d'un futur run auront un dossier UUID distinct par profil sous sa racine dédiée et conserveront le manifeste/checksum des templates.

## Évaluation actuelle

Les scénarios A, B et C sont définis mais **tous `NOT_RUN`** par Mission 29. La sélection du mod tiers est `BLOCKED` et Processia n'a pas été testé. Les tests AVA hors ligne ne constituent pas une preuve runtime.
