# Руководство по разработке плагинов для DeepUpgrade

Плагины в DeepUpgrade представляют собой ZIP-архивы, содержащие JavaScript-код, манифест метаданных и произвольные ассеты (JSON-схемы, CSS-стили, HTML-шаблоны, изображения и другие файлы).

Плагины расширяют возможности автономного агента DeepSeek: они регистрируют новые инструменты (Tools), вызываемые моделью через блоки ` ```json:tool `, выполняют вычисления в браузере и могут взаимодействовать с файловой системой VFS.

---

## 1. Структура ZIP-архива плагина

### Минимальная структура
Архив может содержать всего один файл `index.js`:
```
my-tool.zip
└── index.js
```

### Рекомендуемая структура (многофайловый плагин с ассетами)
```
weather-plugin.zip
├── plugin.json            # Манифест с метаданными и точкой входа
├── index.js               # Главный файл плагина
├── utils/
│   └── formatter.js       # Вспомогательный JS-модуль
└── assets/
    ├── style.css          # Стили для инъекции в страницу
    ├── cities.json        # Статические данные / конфигурация
    └── icon.png           # Графический ассет (доступен как Data URL)
```

> **Примечание:** Если вы запаковали архив вместе с корневой папкой (например, `weather-plugin/plugin.json`), DeepUpgrade автоматически определит общий префикс и выровняет пути к файлам.

---

## 2. Манифест `plugin.json`

Файл `plugin.json` (также поддерживается `manifest.json`) задает базовые метаданные плагина:

```json
{
  "name": "weather_service",
  "version": "1.0.0",
  "description": "Инструмент получения погоды и климатических сводок для агента",
  "main": "index.js",
  "author": "Your Name"
}
```

### Поля манифеста:
- `name` *(обязательно)*: Уникальное имя плагина (латиница, без пробелов).
- `version`: Строка версии в формате SemVer (по умолчанию `1.0.0`).
- `description`: Краткое описание функционала.
- `main`: Относительный путь к точке входа (по умолчанию ищется `index.js`, `main.js` или `plugin.js`).

---

## 3. Объект `DeepUpgrade` API

При инициализации в скрипт передается глобальный контекст `DeepUpgrade`:

### 3.1. Регистрация инструментов (`registerTool` / `defineTool`)

Позволяет модели вызывать ваш инструмент в процессе генерации ответа.

```javascript
DeepUpgrade.registerTool({
  name: "get_weather",
  description: "Получает текущую погоду по названию города",
  icon: "globe", // 'globe' | 'terminal' | 'edit' | 'search' | 'calc' | 'code' | 'database' | кастомный SVG
  parameters: {
    city: { type: "string", description: "Название города (например: Москва)", required: true },
    format: { type: "string", description: "Формат ответа (j1 или plain)", default: "j1" }
  },
  execute: async (args) => {
    const city = encodeURIComponent(args.city || "Moscow");
    // Выполняем сетевой запрос через встроенный HTTP-клиент DeepUpgrade
    const data = await DeepUpgrade.http.get(`https://wttr.in/${city}?format=j1`);
    const temp = data.current_condition[0].temp_C;
    const desc = data.current_condition[0].weatherDesc[0].value;
    return `Погода в ${args.city}: ${temp}°C, ${desc}`;
  }
});
```

- **Параметры и промпт:** Описание параметров и пример вызова автоматически компилируются и встраиваются в системный промпт DeepSeek (`[AVAILABLE JS PLUGIN TOOLS]`), поэтому модель точно знает, какие аргументы передавать.
- **Иконка карточки (`icon`):** Задает иконку, которая отображается слева в шапке карточки вызова инструмента (рядом с названием). Можно использовать ключевые слова (`globe`, `terminal`, `edit`, `search`, `calc`, `code`, `database`), эмодзи или сырой SVG (`<svg ...>`).

---

### 3.2. Сетевые веб-запросы (`DeepUpgrade.http` и `DeepUpgrade.fetch`)

В браузере обычные запросы `fetch` из страницы блокируются политиками CSP (Content Security Policy) и CORS. DeepUpgrade предоставляет привилегированный сетевой транспорт через Service Worker расширения с разрешением `<all_urls>`, который полностью обходит ограничения CORS и CSP:

```javascript
// 1. Быстрый GET-запрос с автоматическим парсингом JSON:
const weather = await DeepUpgrade.http.get('https://wttr.in/London?format=j1');

// 2. GET с передачей query-параметров в объекте:
const searchResults = await DeepUpgrade.http.get('https://api.github.com/search/repositories', {
  q: 'deepseek',
  sort: 'stars',
  per_page: 5
});

// 3. POST-запрос с JSON телом:
const result = await DeepUpgrade.http.post('https://api.example.com/data', {
  query: "test",
  apiKey: "secret"
});

// 4. Низкоуровневый fetch (сигнатура стандартного fetch):
const response = await DeepUpgrade.fetch('https://example.com/site.html');
const htmlText = await response.text();
```

---

### 3.2. Работа с ассетами (`getAsset` / `getFile`)

Позволяет читать файлы, включенные в ZIP-архив:

```javascript
// Автоматический формат (текст для текстовых файлов, base64 для бинарных)
const configRaw = DeepUpgrade.getAsset('assets/cities.json');
const config = JSON.parse(configRaw);

// Явное чтение текста:
const templateHtml = DeepUpgrade.getAsset('templates/card.html', 'text');

// Получение Data URL для вставки картинок в DOM:
const iconDataUrl = DeepUpgrade.getAsset('assets/icon.png', 'dataurl');
// Вернёт: data:image/png;base64,iVBORw0KGgo...
```

Поддерживаемые форматы второго аргумента:
- `'auto'` (по умолчанию): возвращает `string` текста для текстовых файлов и `base64` для бинарных.
- `'text'`: строго строковый UTF-8 вывод.
- `'base64'`: Base64 представление байтов файла.
- `'dataurl'`: строка `data:<mime>;base64,...` с автоматическим определением MIME-типа по расширению.

---

### 3.3. Модульность скриптов (`require`)

Для сложных плагинов код можно разделять на несколько файлов с использованием экспорта в стиле CommonJS:

**Файл `utils/math.js`:**
```javascript
module.exports = {
  add: (a, b) => a + b,
  multiply: (a, b) => a * b
};
```

**Файл `index.js`:**
```javascript
const math = DeepUpgrade.require('./utils/math.js');

DeepUpgrade.registerTool({
  name: "custom_math",
  description: "Математический инструмент",
  execute: async (args) => {
    return "Сумма: " + math.add(Number(args.a), Number(args.b));
  }
});
```

---

### 3.4. Инъекция стилей (`injectCSS`)

Если плагин выводит кастомные карточки или элементы в интерфейс, он может применить свои CSS-стили:

```javascript
// Из ассета архива:
DeepUpgrade.injectCSS('assets/style.css');

// Либо напрямую из строки:
DeepUpgrade.injectCSS(`
  .du-custom-widget {
    background: #1e293b;
    border-radius: 8px;
    padding: 12px;
  }
`);
```

---

### 3.5. Постоянное хранилище плагина (`storage`)

Каждый плагин изолированно сохраняет свои настройки и данные:

```javascript
// Чтение значения с fallback
const apiKey = DeepUpgrade.storage.get('api_token', 'default_token');

// Сохранение значения (сериализуется в JSON)
DeepUpgrade.storage.set('api_token', 'secret_xyz');
```

---

### 3.6. Доступ из VFS и системной песочницы

Все распакованные файлы плагина автоматически монтируются в виртуальную файловую систему браузера (VFS/OPFS) по пути:
```
/plugins/<id_плагина>/...
```
Скрипты агента на Python (Pyodide) или терминальные команды в песочнице могут напрямую обращаться к вашим файлам по этому пути, например:
```python
with open('/plugins/plug_calc_sample/help.json') as f:
    print(f.read())
```

---

## 4. Пошаговый пример создания плагина

Создадим плагин **"Regex Tester"**, проверяющий регулярные выражения на наборе тестовых строк из ассета.

### Шаг 1: Создайте папку проекта
```bash
mkdir regex-plugin
cd regex-plugin
```

### Шаг 2: Создайте `plugin.json`
```json
{
  "name": "regex_tester",
  "version": "1.0.0",
  "description": "Тестирует регулярные выражения и возвращает совпадения",
  "main": "index.js"
}
```

### Шаг 3: Создайте файл с данными `examples.json`
```json
{
  "email": "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$",
  "phone": "^\\+?[0-9]{10,15}$"
}
```

### Шаг 4: Напишите логику в `index.js`
```javascript
const defaultPatterns = JSON.parse(DeepUpgrade.getAsset('examples.json') || '{}');

DeepUpgrade.registerTool({
  name: "test_regex",
  description: "Проверяет регулярное выражение на строке. Аргументы: { pattern: string, text: string, flags?: string }",
  execute: async (args) => {
    let pattern = args.pattern || '';
    const text = String(args.text || '');
    const flags = args.flags || 'g';

    if (defaultPatterns[pattern]) {
      pattern = defaultPatterns[pattern];
    }

    try {
      const rx = new RegExp(pattern, flags);
      const matches = [...text.matchAll(rx)].map(m => m[0]);
      return JSON.stringify({
        pattern,
        matched: matches.length > 0,
        count: matches.length,
        matches
      }, null, 2);
    } catch (err) {
      return "Ошибка регулярного выражения: " + err.message;
    }
  }
});
```

### Шаг 5: Запакуйте в ZIP
Выделите файлы `plugin.json`, `examples.json`, `index.js` и сожмите их в ZIP-архив `regex-plugin.zip`.

### Шаг 6: Установка в DeepUpgrade
1. Откройте **Settings** в DeepSeek (шестеренка в левом нижнем углу).
2. Перейдите во вкладку **DeepUpgrade**.
3. Перетащите `regex-plugin.zip` в область Drag & Drop (или нажмите для выбора файла).
4. Плагин готов к работе — агент в чате теперь может вызывать `test_regex`.
