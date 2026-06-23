# 💬 Продолжи фразу

Мультиплеерная игра с QR-кодом для подключения игроков.

## Структура

```
phrase-game/
├── server.js          # Node.js + WebSocket сервер
├── package.json
├── railway.toml       # конфиг для Railway
└── public/
    ├── index.html     # Экран хоста (большой экран / телефон ведущего)
    └── join.html      # Экран игрока (открывается по QR-коду)
```

## Как играть

1. Хост открывает `index.html` (корень сайта)
2. Появляется QR-код — каждый игрок сканирует его своим телефоном
3. Игроки вводят имя и подключаются к комнате
4. Хост нажимает «Начать игру»

## Деплой на Railway

### Шаг 1 — Залей на GitHub
```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/ВАШ_НИК/phrase-game.git
git push -u origin main
```

### Шаг 2 — Railway
1. Зайди на [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Выбери репозиторий `phrase-game`
4. Railway автоматически найдёт `package.json` и задеплоит
5. В разделе **Settings → Networking** нажми **Generate Domain**
6. Готово! Открывай ссылку — это и есть экран хоста

### Переменные окружения
Не нужны — всё работает из коробки.

## Локальный запуск
```bash
npm install
npm start
# Открой http://localhost:3000
```
