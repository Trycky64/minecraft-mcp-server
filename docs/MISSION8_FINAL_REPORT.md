# Mission 8 — validation fonctionnelle

Date de validation : 2026-10-14 (Windows x64).

## Verdict

**PARTIAL.** Les validations statiques finales passent et les preuves antérieures du placement ainsi que du bridge Processia restent disponibles. La session GUI unique s'est authentifiée et a atteint le monde, mais l'orchestrateur a échoué avant d'ouvrir les Options; il a ensuite arrêté le processus graphique. À la demande de l'utilisateur, aucun second client n'a été démarré. Les changements de résolution, l'écran musical et la revalidation GUI complète restent donc non testés dans cette reprise.

## Changements vérifiés

- Le harness attend une disponibilité explicite du client et du monde plutôt qu'un simple délai. Tests Java couvrent les états de readiness et la condition de menu.
- La condition `menu:<id>` a été corrigée pour ne pas appeler `getAsString()` sur une valeur JSON nulle.
- Le MCP inclut les protections de placement et les vérifications post-action déjà présentes dans les changements non commités.
- Aucun fichier source Processia ou MCP n'a été restauré ou réinitialisé durant cette reprise.

## Résultats

| Scénario | Résultat | Preuve / limite |
|---|---|---|
| `npm ci` | PASS | Installation depuis le lockfile existant; 15 avis signalés par npm. |
| Build MCP | PASS | `npm run build`. |
| Tests MCP | PASS | `npm test`, 225 tests. |
| Lint MCP | PASS | `npm run lint`. |
| Build + tests Processia | PASS | `gradlew.bat test build --no-daemon --max-workers=1 --rerun-tasks`; 23 tests, 0 échec/erreur/ignoré. |
| Build + tests bridge | PASS | `gradlew.bat -p neoforge-bridge test build --no-daemon --max-workers=1 --rerun-tasks`; 5 tests, 0 échec/erreur/ignoré. |
| GUI authentification / readiness | PASS | Une instance lancée par `gui-start-client`, liée au serveur `127.0.0.1:25665`, Processia/NeoForge 21.1.259. Journal : `C:/Users/qperr/minecraft-mcp-test/logs/mission8-same-gui-client.json`. L'écran `ReceivingLevelScreen` a été suivi d'un état `clientReady=true`, `interactionReady=true`; cible observée `processia:crusher` en `(12,112,-13)`. |
| Désactivation musique | NOT TESTED | Le script a trouvé `screenClass=null` après readiness et s'est arrêté avant le menu pause/options. Le client a été fermé par le nettoyage du script. Aucun autre client n'a été lancé; aucun fichier de configuration audio personnel n'a été modifié. |
| Capture stabilisée GUI pendant cette reprise | NOT TESTED | Aucun screenshot post-readiness n'a été produit avant l'échec d'orchestration. Les anciennes captures 1280×720/1600×900 ne sont pas recyclées comme preuve actuelle. |
| Menu Crusher / slots / valeurs synchronisées pendant cette reprise | NOT TESTED | Les étapes de menu n'ont pas été atteintes. Les observations antérieures sont historiques et restent détaillées dans les journaux de Mission 7/P3. |
| Placement adjacent et distant | PASS (preuve existante) | `C:/Users/qperr/minecraft-mcp-test/logs/mission8-vanilla-adjacent-placement-dynamic.json`, `mission8-vanilla-distant-placement-runtime.json`, `mission8-vanilla-distant-placement-reconnect.json`. Placements observés dans le monde jetable avec confirmation de lecture serveur et décrément d'inventaire après reconnexion. |
| Bloc Processia / inspection serveur | PASS (preuve existante de la même session de travail) | Crusher observé en `(12,112,-13)` et bridge Processia lié à l'identité `8a5a9825-a992-46db-8cbe-76af164d0ca5`, époque `a960a211-d8e6-43ad-a7f2-84ef407da8ea`. Le rapport de progression MCP contient le refresh des registres et les métadonnées; aucun identifiant n'est généralisé au-delà de cette époque. |
| Generic NeoForge et Mekanism | NOT TESTED dans cette reprise | Les preuves Mission 7 sont historiques; aucun profil serveur n'a été redémarré ici. |

## Incident GUI

L'écran initial d'accueil Minecraft a été fermé dans le même processus graphique. Le client s'est connecté, a traversé `ReceivingLevelScreen`, puis a atteint le monde. Le script supposait qu'un `PauseScreen` était déjà ouvert avant d'ouvrir `Options`; le harness a correctement rapporté l'écran courant nul, mais l'orchestrateur a alors traité ce cas comme fatal et appelé `gui-stop-client`. À la suite de la demande d'utiliser toujours le même client, aucun nouveau processus graphique n'a été lancé. L'instance présente n'est donc pas réutilisable pour terminer les tests GUI sans redémarrage explicite.

## Sécurité et limites

- Le serveur isolé utilise les ports loopback 25665 (Minecraft) et 25677 (bridge); le port 25565 n'a pas été sollicité.
- Le client a été authentifié par le harness et lié à l'identité/époque ci-dessus. Le journal de progression n'expose aucun secret.
- Le GUI harness est en mode `TEST_MUTATION`; aucune action d'inventaire, de menu ou de monde n'a été exécutée pendant cette reprise.
- Pas de nouvelle validation runtime vanilla/générique/Mekanism après le dernier état de dépendances.

## Critère de clôture

Mission 8 reste **ouverte** jusqu'à une nouvelle session autorisée du client GUI pour régler Music à zéro et vérifier framebuffer/résolutions/menu/slots. Cette reprise n'a pas touché au serveur personnel ni à son port.
