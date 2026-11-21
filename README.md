# Veille – surveillance de pages web

Un petit outil de veille hébergé **entièrement sur GitHub**, sans serveur :

- **GitHub Actions** contrôle toutes les heures les pages listées dans `urls.json` ;
- chaque modification est enregistrée dans `data/` (avec historique) et **notifiée sur votre téléphone** par Web Push, directement par l'app web, sans service tiers ;
- une **interface web** sur GitHub Pages, pensée pour l'iPhone et installable sur l'écran d'accueil, affiche l'état de chaque page et permet d'ajouter, modifier ou supprimer des URL.

```
urls.json                     liste des pages à surveiller
scripts/check.py              script de contrôle (requests + BeautifulSoup)
scripts/webpush.py            envoi Web Push (chiffrement RFC 8291 + VAPID)
data/status.json              état courant, mis à jour et commité à chaque passage
data/snapshots/<id>.txt       dernier texte extrait de chaque page
data/history/<id>.json        historique des modifications (100 dernières)
web/                          interface (HTML/CSS/JS sans framework)
.github/workflows/veille.yml  contrôle horaire + déploiement de GitHub Pages
.github/dependabot.yml        mises à jour hebdomadaires des actions et dépendances
tests/                        tests (unittest, sans dépendance supplémentaire)
requirements.in / .txt        dépendances, figées avec leurs hash
```

---

## Installation

### 1. Récupérer le dépôt

Sur la page du dépôt, cliquez sur **Use this template → Create a new repository**, ou faites un *fork*.
Le dépôt doit être **public** pour bénéficier gratuitement de GitHub Pages et des minutes Actions illimitées.

> ⚠️ Dans un dépôt public, `urls.json` et `data/` (le texte des pages surveillées) sont visibles par tous. Les abonnements aux notifications, eux, sont stockés dans une variable privée du dépôt.

### 2. Créer la clé des notifications (VAPID)

Les notifications Web Push sont signées par une clé privée, à garder en secret dans le dépôt.

1. Générez une paire de clés, au choix :
   ```bash
   pip install --require-hashes -r requirements.txt && python scripts/webpush.py generate
   ```
   ou, avec Node.js : `npx web-push generate-vapid-keys` (seule la *Private Key* sert).
2. Dépôt → **Settings → Secrets and variables → Actions → Secrets → New repository secret**
   - *Name* : `VAPID_PRIVATE_KEY`
   - *Secret* : la clé privée (43 caractères, par exemple `x3Fq…`).

La clé publique n'est pas à saisir : le workflow la calcule et la publie dans `vapid.json` avec l'interface.

### 3. Autoriser le workflow à écrire

**Settings → Actions → General → Workflow permissions** : cochez **Read and write permissions**, puis **Save**.
Le workflow déclare déjà les droits dont il a besoin, mais ce réglage peut les bloquer dans certains comptes ou organisations.

### 4. Activer GitHub Pages

**Settings → Pages → Build and deployment → Source** : choisissez **GitHub Actions**.

### 5. Lancer un premier contrôle

**Actions → Veille → Run workflow**. Le premier passage enregistre l'état de référence de chaque page, sans envoyer de notification.
À la fin, l'interface est en ligne à l'adresse `https://<votre-compte>.github.io/<nom-du-depot>/`.

### 6. Créer le jeton fine-grained pour l'interface

L'interface modifie `urls.json` via l'API GitHub. Elle a besoin d'un jeton **limité à ce seul dépôt** :

1. Ouvrez **GitHub → photo de profil → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**, ou directement <https://github.com/settings/personal-access-tokens/new>.
2. **Token name** : `Veille iPhone` par exemple.
3. **Expiration** : votre choix (90 jours, un an, ou sans expiration).
4. **Repository access** : **Only select repositories**, puis sélectionnez **uniquement ce dépôt**.
5. **Permissions → Repository permissions** :
   - **Contents** : **Read and write** (obligatoire, pour modifier `urls.json`) ;
   - **Variables** : **Read and write** (pour enregistrer l'abonnement aux notifications de chaque appareil) ;
   - **Actions** : **Read and write** (facultatif, pour les boutons « Lancer un contrôle maintenant » et « Envoyer une notification de test ») ;
   - *Metadata : Read-only* est ajouté automatiquement.
6. **Generate token**, puis copiez le jeton (`github_pat_…`). Il ne sera plus affiché.

### 7. Installer l'interface sur l'iPhone et activer les notifications

1. Ouvrez `https://<votre-compte>.github.io/<nom-du-depot>/` dans **Safari**.
2. Touchez **Partager** puis **Sur l'écran d'accueil**.
3. **Ouvrez l'app depuis son icône**. Les notifications Web Push ne fonctionnent que dans l'app installée (iOS 16.4 ou plus récent), pas dans Safari.
4. Touchez **⚙︎**, collez le jeton et touchez **Enregistrer**. Le message « ✓ Accès en écriture » confirme que tout est prêt.
5. Dans la même fenêtre, touchez **Activer les notifications sur cet appareil**, puis **Autoriser**.
6. Touchez **Envoyer une notification de test** : elle arrive en une à deux minutes, le temps que le workflow tourne.

Répétez les étapes 3 à 5 sur chaque appareil à notifier (iPhone, iPad, Mac, Android…).

Le jeton est gardé dans le `localStorage` de l'appareil et n'est envoyé qu'à `api.github.com`. Le bouton **Oublier le jeton** l'efface. Les notifications restent actives même sans jeton.

---

## Utilisation

- **＋** : ajouter une URL (nom, adresse, sélecteur CSS facultatif).
- **⋯** sur une carte : ouvrir la page, la modifier ou la supprimer.
- **Dernier changement** : aperçu du diff (en vert les lignes ajoutées, en rouge les lignes supprimées). **Historique complet** affiche les modifications précédentes.
- Une bordure bleue signale les pages modifiées dans les dernières 24 h.

Chaque enregistrement depuis l'interface crée un commit sur `urls.json`, ce qui lance aussitôt un contrôle. Les nouvelles pages ont donc leur état de référence en une à deux minutes.

### Format de `urls.json`

```json
[
  { "name": "Prix du billet", "url": "https://exemple.fr/billet", "selector": "#prix" },
  { "name": "Actualités", "url": "https://exemple.fr/actus" }
]
```

`selector` accepte n'importe quel sélecteur CSS reconnu par BeautifulSoup, plusieurs sélecteurs séparés par des virgules compris. Sans sélecteur, tout le texte de la page est comparé (balises `script`, `style`, etc. exclues). Une page est identifiée par son URL et son sélecteur. Changer l'un ou l'autre repart donc d'un nouvel état de référence, alors que renommer une page conserve son historique.

### Notifications (Web Push)

Pour chaque modification, chaque appareil abonné reçoit une notification **« Modifié : nom de la page »** avec le nombre de lignes ajoutées et supprimées et un extrait du texte changé. **Toucher la notification ouvre l'app sur la carte de la page**, diff déplié.

- **Où sont stockés les abonnements ?** Dans la variable de dépôt `PUSH_SUBSCRIPTIONS` (Settings → Secrets and variables → Actions → Variables). Elle n'est pas publique, contrairement aux fichiers du dépôt. L'interface la met à jour quand vous activez ou désactivez un appareil.
- **Abonnement expiré** (app supprimée, iPhone restauré…) : le contrôle le détecte, et l'interface le retire de la variable à sa prochaine ouverture avec le jeton. Il suffit ensuite de réactiver les notifications sur l'appareil concerné.
- **Notifications refusées par erreur** : réautorisez-les dans **Réglages iOS → Notifications → Veille**.
- Les erreurs (page inaccessible, sélecteur introuvable) ne sont pas notifiées : elles s'affichent en jaune dans l'interface.
- `data/status.json` indique dans `push` le nombre d'appareils abonnés, de notifications envoyées et les éventuelles erreurs d'envoi.

---

## Bon à savoir

- **Fréquence réelle** : le workflow est planifié toutes les heures, mais GitHub retarde ou saute souvent les tâches planifiées des petits dépôts publics. En pratique, on observe parfois un contrôle toutes les 6 à 9 heures. Le bouton « Lancer un contrôle maintenant » et toute modification de `urls.json` déclenchent un contrôle immédiat.
- **Pages dynamiques** : le script lit le HTML tel que le serveur l'envoie, sans exécuter de JavaScript. Une page dont le contenu est généré côté navigateur peut donc paraître vide ou figée. Ciblez alors un sélecteur présent dans le HTML initial.
- **Contenu changeant** (horloge, compteur, publicité…) : il provoque de fausses alertes. Utilisez un sélecteur pour ne surveiller que la zone utile.
- **Inactivité** : GitHub désactive les workflows planifiés d'un dépôt public sans activité pendant 60 jours. Les commits horaires de `data/status.json` maintiennent normalement le dépôt actif. Si le workflow est désactivé malgré tout, réactivez-le depuis l'onglet **Actions**.
- **Mise à jour de l'interface** : GitHub Pages met parfois quelques minutes à servir la nouvelle version. Le bouton **↻** recharge les données.

## Sécurité

- **Interface** : politique de sécurité du contenu (CSP) stricte avec *Trusted Types*. Seuls les scripts du site s'exécutent, et le réseau n'est ouvert que vers `api.github.com`. Aucune bibliothèque tierce, aucun `innerHTML`. Les liens n'acceptent que `http(s)`, ce qui bloque une URL `javascript:` glissée dans `urls.json`.
- **Jeton** : il est stocké dans le `localStorage`, donc accessible à tout script de la même origine. Or, sur `https://<compte>.github.io/`, **tous les sites GitHub Pages de votre compte partagent la même origine**. Ne publiez pas sur ce compte d'autres sites Pages en lesquels vous n'avez pas confiance, ou servez Veille depuis un domaine personnalisé. Limitez le jeton à ce dépôt et donnez-lui une date d'expiration.
- **Script de contrôle** : il n'accepte que des URL `http(s)` publiques. Les adresses privées, locales ou de métadonnées cloud sont refusées, y compris après une redirection, ce qui protège contre les attaques SSRF. Les pages sont limitées à 5 Mo et aux types texte/HTML. Le texte issu des pages ne peut pas injecter de commandes dans les logs du workflow.
- **Notifications** : elles ne partent que vers les services push des navigateurs (Apple, Google, Mozilla, Microsoft). La clé VAPID reste un secret GitHub, et les abonnements sont dans une variable privée.
- **Chaîne d'approvisionnement** : les actions GitHub sont épinglées par SHA et les dépendances Python sont figées avec leurs hash (`--require-hashes`). Chaque job n'a que les permissions dont il a besoin. Dependabot propose chaque semaine les mises à jour.

## Développement local

```bash
python -m venv .venv && . .venv/bin/activate && pip install --require-hashes -r requirements.txt
```

```bash
python -m unittest discover -s tests   # tests (lancés aussi par le workflow à chaque push)
```

```bash
python scripts/check.py   # sans VAPID_PRIVATE_KEY ni PUSH_SUBSCRIPTIONS, aucune notification
```

Pour voir l'interface avec les données locales :

```bash
mkdir -p _site/data && cp -r web/. _site/ && cp urls.json _site/ && cp -r data/status.json data/history _site/data/ && python scripts/webpush.py public > _site/vapid.json && python -m http.server -d _site 8000
```

Mettre à jour les dépendances : modifier `requirements.in`, puis :

```bash
uv pip compile requirements.in --generate-hashes --python-version 3.14 -o requirements.txt
```
