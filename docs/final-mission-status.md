# Mission autonome finale — état de preuve (2026-10-14)

> **Historical snapshot superseded by Mission 7.** The GUI camera behavior, runtime availability, dependency audit and test count below describe an earlier point in the same work. See [MISSION7_FINAL_REPORT.md](MISSION7_FINAL_REPORT.md) and [RELEASE_READINESS.md](RELEASE_READINESS.md) for current results.

## Verdict

**PARTIAL.** La mission complète P0–P6 n'est pas validée. Le code et les tests couvrent des fondations P1/P2, des inspections P3 et un harness GUI, mais P4 n'est pas implémentée comme plan d'administration borné, plusieurs critères P3/P5/P6 ne sont pas prouvés, et le runtime isolé n'était pas actif pendant cette reprise. Le serveur utilisateur `127.0.0.1:25565` n'a pas été contacté ni modifié.

## Changements de cette reprise

- `Processia/src/main/java/com/trycky/processia/client/GuiTestHarness.java`: `/v1/look-at-block` cherche jusqu'à huit positions horizontales dans les chunks déjà chargés; il rejette les positions en collision, vérifie le bloc cible par raycast, puis déplace et oriente le client. Il retourne une erreur structurée si aucune vue claire n'existe. Le déplacement ne charge aucun chunk.
- `Processia/docs/GUI_TEST_HARNESS_P3.md`: décrit cet algorithme et sa limite de validation visuelle.
- `todo.txt`: coche seulement les captures framebuffer/GUI, la couverture multi-résolution/échelle et leur association aux rapports, démontrées dans les preuves P3.5 existantes. Les assertions d'écran qui y échouent n'ont pas été cochées comme validations GUI.

Le code du cadrage a compilé dans le build Gradle du 2026-10-14. Aucune capture après cette correction n'a été produite: le serveur/client isolé n'était pas lancé. La correction est donc **compilée mais non validée en runtime**.

## Résultats exécutés cette reprise

| Dépôt | Commande | Résultat |
|---|---|---|
| Processia | `gradlew.bat build --no-daemon --offline --console=plain` | PASS, `BUILD SUCCESSFUL`; compile Java, tests et `checkSideSeparation` inclus |
| MCP | `npm run build` | PASS |
| MCP | `npm test` | PASS, 200 tests |
| MCP | `npm run lint` | PASS |
| Les deux | `git diff --check` | PASS |
| Runtime | Vérification des listeners 25565/25576/25577/25578 | Aucun listener observé; aucun serveur n'a été démarré |

La dernière preuve GameTest isolée disponible avant cette reprise est `artifacts/p3-visual-redesign/test-results.md`: 44/44 GameTests PASS sur le port distinct 25568. Elle précède le changement du harness et n'est pas une validation runtime de la correction de caméra.

## Limites qui gardent la roadmap ouverte

- P1.19: aucune identification positive des six blocs/items sur le serveur utilisateur; les preuves P3.5 prouvent les six clés et IDs de blocs sur un serveur de test antérieur, mais pas les inventaires/items complets ni placement/orientation/reconnexion pour chaque type. Ne pas réutiliser ces IDs hors de leur epoch.
- P2.8/P2.9: secret statique transmis par environnement, pas de générateur temporaire au démarrage; aucun contrat `requestId` corrélé requête/réponse.
- P2.16: la GUI possède un verrou d'owner; aucune preuve de deux clients MCP indépendants simultanés sur le bridge.
- P3: inspect-machine/recipes existent, mais aucun outil de recherche paginée de machines, aucune API dédiée de capacités par face complète, ni mesure générale des flux/réseaux FE. Capacités disponibles ne prouvent pas un transfert.
- P4: les actions de joueur Mineflayer existantes ne constituent pas le modèle demandé de permissions par outil/client, zone serveur, audit et verrous de ressources. Aucun endpoint de commande arbitraire ne doit être ajouté.
- P5: 8/10 assertions GUI menu précédentes passent; deux échouent de façon transitoire. Les slots, tooltips vanilla, contrôles et persistance n'ont pas tous été validés. Les vues monde P3.5 étaient sous l'eau/mal cadrées dans certains cas. Après correction, aucune capture runtime n'a été reprise.
- P6: 44 GameTests sont prouvés dans le rapport P3.5, mais les scénarios E2E demandés (recettes Press/Wiremill, chaîne Generator→Cable→Battery→Crusher, conservation et persistance après redémarrage, concurrence réelle) ne sont pas intégralement validés.
- Compatibilité d'application Claude Code/Codex: non vérifiée avec les exécutables clients réels durant cette reprise.

Voir le fichier `Processia/artifacts/p3-visual-redesign/runtime-visual-validation.json` pour les preuves runtime antérieures et leurs FAIL/PARTIAL; aucun mapping synthétique n'est présenté comme une observation réelle.
