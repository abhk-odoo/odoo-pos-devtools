# Odoo POS State Debugger

## Overview

Odoo POS State Debugger is a small Chrome extension that helps developers inspect the **Odoo POS frontend state** using **Redux DevTools**.

It reads data from `window.posmodel` and sends POS models and store values to Redux DevTools so you can easily see what is happening inside the POS.

---

# Features

* Detects `window.posmodel` automatically
* Sends POS state to **Redux DevTools**
* Automatically discovers POS models
* Tracks record events:
  * CREATE
  * UPDATE
  * DELETE
* Detects store property changes

---

# Requirements

Install the following before using the extension.

### Redux DevTools - [Link](https://chromewebstore.google.com/detail/redux-devtools/lmhkpmbekcpmknklioeibfkpmmfibljd)

Redux DevTools is used to view the POS state.

---

# Installation

## 1. Download the Extension

Clone the repository or download the ZIP.

```
git clone https://github.com/abhk-odoo/odoo-pos-devtools.git
```

---

## 2. Open Chrome Extensions

Open:

```
chrome://extensions
```

Enable **Developer Mode**.

---

## 3. Load the Extension

Click **Load unpacked** and select the extension folder.

Example structure:

```
odoo-pos-devtools/
 ├── manifest.json
 ├── inject.js
 └── content.js
```

---

# How to Use

## 1. Open Odoo POS

Example:

```
http://localhost:8069/pos/web
```

## 2. Open DevTools

Press:

```
F12
```

## 3. Open Redux Tab

In DevTools open the **Redux** tab.

The debugger will connect automatically.

---

# POS State Structure

Example state shown in Redux DevTools:

```
state
 ├── store
 └── models
```

Example models:

```
product.product
res.partner
pos.order
pos.order.line
```

---

# Example Actions

When data changes you will see actions like:

```
pos.order.line/CREATE
product.product/UPDATE
res.partner/DELETE
STORE/CHANGE
```

---

# Architecture

The extension uses two scripts.

### content.js

* Injects the debugger script into the POS page
* Handles communication with the extension

### inject.js

* Accesses `window.posmodel`
* Serializes POS data
* Sends updates to Redux DevTools

---