# POST server

Сервер принимает HTTP POST-запросы по IPv4-адресу компьютера на порту **80**.
По умолчанию слушает `0.0.0.0`, то есть все сетевые интерфейсы.
Подходит для проверки интеграций и приёма тестовых запросов.

## Запуск в Docker

Нужен Docker с Compose; в Windows — Docker Desktop в режиме Linux containers.
В папке проекта выполните:

```powershell
docker compose up -d --build
```

Сервер будет доступен по `http://<IP-компьютера>:80/` на всех интерфейсах.
Порт 80 на компьютере должен быть свободен. Внутри контейнера сервер слушает
порт 8080 и работает от пользователя `node`; Compose пробрасывает `80:8080`.
Устанавливать Node.js на компьютере для этого способа запуска не нужно.
При первой сборке нужен доступ к реестру образов для загрузки `node:24-alpine`.

Проверка запроса, состояния контейнера и просмотр логов:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:80/' -ContentType 'application/json' -Body '{"message":"hello from Docker"}'
docker compose ps
docker compose logs -f
```

Образ содержит проверку `GET /health` каждые 30 секунд.
Контейнер перезапускается после сбоя или запуска Docker, если не был остановлен вручную.

Журнал `/app/logs/requests.jsonl` хранится в отдельном Docker volume
`post-server-logs` и сохраняется при пересоздании контейнера и `docker compose down`.
В этом режиме файл не появляется автоматически в локальной папке `logs`.
Чтобы скопировать его после приёма запросов на компьютер:

```powershell
docker compose cp post-server:/app/logs/requests.jsonl ./requests.jsonl
```

Остановка с удалением контейнера и сохранением журнала:

```powershell
docker compose down
```

Флаг `--volumes` у этой команды удалит и журнал. Вывод консоли Docker ротируется
(до 3 файлов по 10 МиБ); у самого `requests.jsonl` автоматической ротации нет.

Сборка и запуск без Compose:

```powershell
docker build -t post-server:local .
docker run -d --name post-server -p 80:8080 --restart unless-stopped -v post-server-logs:/app/logs post-server:local
```

Выберите один способ запуска: Compose или `docker run`, поскольку оба занимают порт 80.
Для передачи собранного образа на другую машину:

```powershell
docker save -o post-server.tar post-server:local
# На другой машине:
docker load -i post-server.tar
docker run -d --name post-server -p 80:8080 --restart unless-stopped -v post-server-logs:/app/logs post-server:local
```

Архив образа не включает журнал из volume. Для настройки лимита тела в Compose
добавьте `environment: { MAX_BODY_BYTES: "2097152" }` в сервис `post-server`
и повторите `docker compose up -d --build`.

## Запуск без Docker

Нужен Node.js 22 или новее. Внешних зависимостей нет, `npm install` не нужен.
Откройте терминал в папке проекта и выполните:

```powershell
node server.js
```

Сервер работает, пока открыт процесс. Остановка — `Ctrl+C`.
Если порт занят, сервер выведет `EADDRINUSE`: освободите порт 80
или задайте другой порт через `PORT`.

## Отправка запросов

Пример из PowerShell на том же компьютере:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:80/' -ContentType 'application/json' -Body '{"message":"hello"}'
```

С другого компьютера замените `127.0.0.1` на IPv4-адрес машины с сервером
(посмотреть его можно командой `ipconfig`). Например:

```powershell
Invoke-RestMethod -Method Post -Uri 'http://192.168.1.10:80/webhook' -ContentType 'text/plain' -Body 'test'
```

Поддерживается **любой путь**, включая `/`, `/post`, `/webhook` и параметры запроса.
Можно отправлять JSON, текст, формы, бинарные данные или пустое тело.
Сервер сохраняет тело без разбора и проверки JSON. Поддерживается chunked-передача.
По умолчанию максимальный размер тела — 1 МиБ; при превышении возвращается HTTP 413.

После записи запроса в журнал сервер возвращает HTTP 200:

```json
{"status":"ok","requestId":"уникальный UUID","receivedBytes":19}
```

При ошибке записи возвращается HTTP 500. `GET /health` возвращает
`{"status":"ok"}` и проверяет работу HTTP-сервера. Остальные методы — HTTP 405.

## Журнал

Запросы выводятся в консоль и сохраняются в `logs/requests.jsonl` рядом с `server.js`.
Одна строка — один JSON-объект: ID, время UTC, IP клиента, путь, заголовки и тело.
Тело UTF-8 записывается строкой с `bodyEncoding: "utf8"`, остальные байты —
в Base64 с `bodyEncoding: "base64"`. Заголовки `Authorization`,
`Proxy-Authorization` и `Cookie` скрываются. Тело сохраняется полностью в пределах лимита.
Журнал дополняется при перезапуске; автоматической ротации нет.

## Доступ по сети

Для подключения с другой машины входящие TCP-соединения на порт 80 должны быть
разрешены в брандмауэре. Для доверенной локальной сети с профилем Private
при необходимости выполните в PowerShell **от имени администратора**:

```powershell
New-NetFirewallRule -DisplayName 'POST server TCP 80' -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Private -RemoteAddress LocalSubnet
```

Это правило действует только для частной сети и её локальной подсети.
Если используется другой сетевой профиль или отправитель находится в другой
сети, правило нужно настроить под соответствующий профиль и IP отправителя.
Для доступа из интернета за роутером потребуется внешний адрес и перенаправление
TCP-порта 80 на компьютер с сервером. HTTP здесь без TLS и авторизации.

## Настройки и проверки

Необязательные переменные окружения:

| Переменная | По умолчанию | Значение |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Адрес для прослушивания |
| `PORT` | `80` | TCP-порт |
| `MAX_BODY_BYTES` | `1048576` | Лимит размера тела в байтах |
| `LOG_FILE` | `logs/requests.jsonl` рядом с сервером | Путь журнала; относительный путь считается от текущей папки |

Например, временный запуск на другом порту:

```powershell
$env:PORT = '8080'
node server.js
```

Интеграционные тесты:

```powershell
node --test
```
