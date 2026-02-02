# Front Panel Controller – Linear Breadboard Installation Guide (Pro Micro + AQY212EH + PC817 + H11AA1)

This guide is written to be **followed linearly** (do steps in order) and to be copy-pasted into a repo as documentation.

It covers the four functions you called out:

- **PowerSense** (reads PSU +5V presence via optocoupler → `POWER_SENSE_PIN` = Pro Micro **D2**)
- **PowerButton** (drives motherboard PWR_SW via PhotoMOS → `POWER_BUTTON_PIN` = Pro Micro **D3**)
- **ResetButton** (drives motherboard RESET_SW via PhotoMOS → `RESET_BUTTON_PIN` = Pro Micro **D4**)
- **HardDriveLED** (reads motherboard HDD_LED activity via H11AA1 → `HDD_SENSE_PIN` = Pro Micro **D7**)
- Plus: **OverridePowerButton** (local pushbutton → `OVERRIDE_POWER_BUTTON_PIN` = Pro Micro **D5**)

---

## 0) Assumptions and required parts

### 0.1 Board and firmware assumptions

- Pro Micro is **5V / 16MHz** (per your Amazon listing).
- Pro Micro is installed **straddling the breadboard center trench**, with **USB pointing up**.
- Your sketch uses:
  - `POWER_SENSE_PIN = 2`
  - `POWER_BUTTON_PIN = 3`
  - `RESET_BUTTON_PIN = 4`
  - `OVERRIDE_POWER_BUTTON_PIN = 5`
  - `HDD_SENSE_PIN = 7` *(if your current sketch doesn’t have this yet, add later)*

### 0.2 Parts list (BOM)

- 1× Pro Micro (ATmega32U4) 5V/16MHz
- 2× Panasonic **AQY212EH** (DIP-4 PhotoMOS, “relay-like” contact closure)
- 1× **PC817** optocoupler (DIP-4) for PowerSense
- 1× **H11AA1** optocoupler (DIP-6) for HDD LED sense (polarity-insensitive input)
- 2× **820Ω resistors** (for AQY212EH LED inputs; **definitive** for 5V Pro Micro)
- 1× **850Ω resistor** (for PC817 LED input, using the resistors you already have)
- 1× momentary pushbutton (override)
- Solderless breadboard + jumper wires
- 3× two-pin leads to motherboard headers:
  - PWR_SW (2-pin)
  - RESET_SW (2-pin)
  - HDD_LED (2-pin)
- SATA/Molex breakout or pigtail to obtain **+5V and GND** for PowerSense input

---

## 1) Safety and “don’t do this” list

1. **Do not connect motherboard header ground to Arduino ground directly.**  
   - PWR_SW and RESET_SW are isolated by AQY212EH.
   - HDD_LED is isolated by H11AA1.
2. **Do not connect SATA/Molex GND to Arduino GND directly** for PowerSense.  
   - PowerSense is isolated by PC817.
3. **Do not feed SATA/Molex +5V into Pro Micro VCC/RAW.**  
   - Pro Micro is powered from USB.
4. Breadboard rails are often **split** mid-board. Treat rails as *possibly disconnected* unless you bridge them.

---

## 2) Pin numbering: definitive orientation rules (to eliminate ambiguity)

### 2.1 DIP packages: how pin numbers work

For DIP parts (AQY212EH DIP-4, PC817 DIP-4, H11AA1 DIP-6):

- Identify the **notch** (semi-circle cutout) or **dot** marker.
- **Top view** (you are looking down at the part):
  - With the **notch at the top**, **pin 1 is top-left**.
  - Numbering proceeds **down the left side** (1,2,3…) and continues **up the right side** (…4,5,6).

### 2.2 PC817 pinout (DIP-4) – definitive

Top view (dot/notch at top):

```
   __ notch __
  |          |
1 |  PC817   | 4
2 |          | 3
  |__________|
```

- **Pin 1** = Anode (LED +)
- **Pin 2** = Cathode (LED –)
- **Pin 3** = Emitter
- **Pin 4** = Collector

### 2.3 H11AA1 pinout (DIP-6) – definitive

Top view (**notch at top**):

```
   __ notch __
  |          |
1 |  H11AA1  | 6
2 |          | 5
3 |__________| 4
```

- **Pin 1** = A/C (input)
- **Pin 2** = C/A (input)
- **Pin 3** = NC (no connect)
- **Pin 4** = E (emitter)
- **Pin 5** = C (collector)
- **Pin 6** = B (base)

**Important:** Only pins **1 & 2** connect to the motherboard HDD_LED header (either order). Pins **4 & 5** go to Arduino.

### 2.4 AQY212EH pin roles (DIP-4)

AQY212EH behaves like:
- Pins **1–2**: input LED (Arduino drives through a resistor)
- Pins **3–4**: output “contact” (floating switch; polarity irrelevant)

---

## 3) Breadboard sizing

- **Recommended:** full-size (830 tie-point) breadboard.
- **Minimum:** half-size (~400 tie-point) *can* work, but wiring gets cramped.

---

## 4) Linear installation steps

### Step 1 — Place the Pro Micro

1. Insert the Pro Micro so it **straddles the center trench**.
2. Orient it with **USB connector pointing up**.
3. Confirm you can access these labeled pins:
   - `2`, `3`, `4`, `5`, `7`, and at least one `GND`.

---

### Step 2 — Establish Arduino-side ground rail (recommended approach)

1. Choose one breadboard **ground rail** (e.g., top “–” rail) as **Arduino GND**.
2. Run a jumper from Pro Micro **GND** to that ground rail.
3. If that rail is split, add a jumper bridging the split so the entire rail is ground.

> This rail will be used for: AQY212EH pin 2 (both), PC817 pin 3, H11AA1 pin 4, and the override button return.

---

## 5) PowerButton: PWR_SW via AQY212EH #1 (polarity-agnostic)

### Step 3 — Insert AQY212EH #1

1. Insert AQY212EH #1 **across the center trench** (so two pins on each side).
2. Orient it so you can reliably identify **pin 1** (notch/dot end).

### Step 4 — Wire AQY212EH #1 input (Arduino side)

1. Pro Micro **D3** → **820Ω** → AQY212EH #1 **pin 1**
2. AQY212EH #1 **pin 2** → **Arduino GND rail**

### Step 5 — Wire AQY212EH #1 output (Motherboard side)

1. Motherboard **PWR_SW** wire A → AQY212EH #1 **pin 3**
2. Motherboard **PWR_SW** wire B → AQY212EH #1 **pin 4**

**Polarity does not matter** on pins 3/4.

---

## 6) ResetButton: RESET_SW via AQY212EH #2 (polarity-agnostic)

### Step 6 — Insert AQY212EH #2

1. Insert AQY212EH #2 across the center trench.

### Step 7 — Wire AQY212EH #2 input (Arduino side)

1. Pro Micro **D4** → **820Ω** → AQY212EH #2 **pin 1**
2. AQY212EH #2 **pin 2** → **Arduino GND rail**

### Step 8 — Wire AQY212EH #2 output (Motherboard side)

1. Motherboard **RESET_SW** wire A → AQY212EH #2 **pin 3**
2. Motherboard **RESET_SW** wire B → AQY212EH #2 **pin 4**

**Polarity does not matter** on pins 3/4.

---

## 7) PowerSense: SATA/Molex +5V via PC817 → Pro Micro D2

Goal: detect whether PSU +5V is present, without tying PSU ground to Arduino ground.

### Step 9 — Insert PC817

1. Insert PC817 across the center trench (DIP-4).

### Step 10 — Wire PC817 input (PSU side)

1. SATA/Molex **+5V** → **850Ω** → PC817 **pin 1** (anode)
2. SATA/Molex **GND** → PC817 **pin 2** (cathode)

> This side is **PSU domain**. Do **not** connect PSU GND to Arduino GND elsewhere.

### Step 11 — Wire PC817 output (Arduino side)

1. PC817 **pin 3** (emitter) → **Arduino GND rail**
2. PC817 **pin 4** (collector) → Pro Micro **D2** (`POWER_SENSE_PIN`)

Pro Micro D2 remains configured as `INPUT_PULLUP`, so:
- PC817 ON → D2 pulled LOW
- PC817 OFF → D2 reads HIGH

---

## 8) HardDriveLED: Motherboard HDD_LED via H11AA1 → Pro Micro D7 (polarity-agnostic)

Goal: detect HDD activity without caring about HDD_LED header polarity.

### Step 12 — Insert H11AA1

1. Insert H11AA1 across the center trench (DIP-6).
2. **Orient the notch up** so you can follow the pin map:
   - Left side top→bottom: pins **1,2,3**
   - Right side bottom→top: pins **4,5,6**

### Step 13 — Wire motherboard HDD_LED header (polarity does not matter)

1. Motherboard HDD_LED wire A → H11AA1 **pin 1**
2. Motherboard HDD_LED wire B → H11AA1 **pin 2**

Pin 3 is **NC** — leave it unconnected.

### Step 14 — Wire H11AA1 output to Arduino

1. H11AA1 **pin 4** (emitter) → **Arduino GND rail**
2. H11AA1 **pin 5** (collector) → Pro Micro **D7** (`HDD_SENSE_PIN`)

Leave **pin 6** (base) unconnected initially.

---

## 9) OverridePowerButton: local pushbutton to D5

### Step 15 — Wire override pushbutton

1. Place a momentary pushbutton anywhere convenient.
2. One side of the button → Pro Micro **D5**
3. Other side of the button → **Arduino GND rail**

Your sketch uses `INPUT_PULLUP` so no external resistor is needed.

---

## 10) Final connection summary (copy/paste checklist)

### AQY212EH #1 (PWR_SW)
- D3 → 820Ω → AQY1 pin 1
- AQY1 pin 2 → Arduino GND
- Motherboard PWR_SW → AQY1 pins 3 & 4 (either order)

### AQY212EH #2 (RESET_SW)
- D4 → 820Ω → AQY2 pin 1
- AQY2 pin 2 → Arduino GND
- Motherboard RESET_SW → AQY2 pins 3 & 4 (either order)

### PC817 (PowerSense from SATA/Molex +5V)
- PSU +5V → 850Ω → PC817 pin 1
- PSU GND → PC817 pin 2
- PC817 pin 3 → Arduino GND
- PC817 pin 4 → D2

### H11AA1 (HDD_LED sense)
- Motherboard HDD_LED → H11AA1 pins 1 & 2 (either order)
- H11AA1 pin 4 → Arduino GND
- H11AA1 pin 5 → D7

### Override button
- Button between D5 and Arduino GND

---

## 11) Verification / troubleshooting (quick)

### 11.1 Confirm Pro Micro pins in Arduino IDE
- Ensure the board definition matches a Pro Micro / ATmega32U4.
- Confirm that “D2/D3/D4/D5/D7” correspond to the silkscreen pins you’re using.

### 11.2 Sanity checks with a multimeter
- Arduino GND rail continuity: Pro Micro GND ↔ rail should be ~0Ω.
- PC817 LED side: diode-test across pins 1–2 should behave like a diode.

### 11.3 If PowerSense never changes
- Verify SATA/Molex +5V is actually present.
- Verify PC817 orientation (pin 1 at notch/dot end).
- Verify D2 configured as `INPUT_PULLUP`.

### 11.4 If HDD activity never triggers
- Verify H11AA1 notch orientation and pin numbering.
- Confirm motherboard HDD_LED header is the correct pins.
- Confirm D7 configured as `INPUT_PULLUP` and your sketch is actually reading/reporting it.

---

## 12) Notes on “OctoSwitch”
In this documentation, “OctoSwitch” is **not used for PWR_SW/RESET_SW** anymore. The **AQY212EH replaces that role** (and is what provides polarity independence for those switch headers).
