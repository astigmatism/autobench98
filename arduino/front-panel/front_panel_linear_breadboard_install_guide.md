# Front Panel Controller – Linear Breadboard Installation Guide (Pro Micro + OLED + AQY212EH + PC817 + H11AA1)

This guide is written to be **followed linearly** (do steps in order) and to be copy-pasted into a repo as documentation.

It covers these functions:

- **OLED Status Display** (0.96" 128×64 I²C) via **hardware I²C** on Pro Micro
    - **SDA = D2**, **SCL = D3**
- **PowerSense** (reads PSU +5V presence via optocoupler → `POWER_SENSE_PIN` = Pro Micro **D6**)
- **PowerButton** (drives motherboard PWR_SW via PhotoMOS → `POWER_BUTTON_PIN` = Pro Micro **D9**)
- **ResetButton** (drives motherboard RESET_SW via PhotoMOS → `RESET_BUTTON_PIN` = Pro Micro **D8**)
- **HardDriveLED** (reads motherboard HDD_LED activity via H11AA1 → `HDD_SENSE_PIN` = Pro Micro **D7**)
- Plus: **OverridePowerButton** (local pushbutton → `OVERRIDE_POWER_BUTTON_PIN` = Pro Micro **D15**)

---

## 0) Assumptions and required parts

### 0.1 Board and firmware assumptions

- Pro Micro / ATmega32U4 board is **5V / 16MHz**.
- Pro Micro is installed **straddling the breadboard center trench**, with **USB pointing up**.
- Your updated pin mapping is assumed to be:
    - `OLED_SDA = 2` (HW I²C SDA)
    - `OLED_SCL = 3` (HW I²C SCL)
    - `POWER_SENSE_PIN = 6`
    - `HDD_SENSE_PIN = 7`
    - `RESET_BUTTON_PIN = 8`
    - `POWER_BUTTON_PIN = 9`
    - `OVERRIDE_POWER_BUTTON_PIN = 15`

> Important: because OLED uses D2/D3, **PowerSense has moved to D6** (polled + debounced).  
> HDD stays on **D7** to preserve external-interrupt capability for edge counting.

### 0.2 OLED module requirements (so you don’t have to chase listings later)

This guide assumes a common 0.96" I²C OLED breakout. To be compatible with wiring it to **Pro Micro VCC (5V)**:

- The module **must** accept **VCC = 5V** _or_ have an onboard regulator that makes it 5V-tolerant.
- I²C pullups (if present) should pull SDA/SCL to **either 3.3V or 5V** (both are typically workable for an ATmega32U4 running at 5V).
- Interface must be **I²C 4-pin**: `GND / VCC / SCL / SDA`.

If your OLED is **3.3V-only**, do **not** power it from Pro Micro VCC.

### 0.3 Parts list (BOM) with “spec snapshots”

This is the same BOM as before, but with the key **datasheet-level** values that matter for this build.

#### 0.3.1 Pro Micro / ATmega32U4 (5V/16MHz)

- Supply: 5V logic (USB-powered)
- I²C pins used by this design: **D2 (SDA)**, **D3 (SCL)**
- External-interrupt pin used by this design: **D7** (for HDD edge counting)

#### 0.3.2 AQY212EH (PhotoMOS, DIP-4) ×2 (PWR_SW, RESET_SW)

- Function: isolated “dry contact” closure on motherboard header pins
- Package: DIP-4, **1 Form A** (SPST-NO)
- **Load voltage (max): 60 V**
- **Continuous load current (max): 0.55 A**
- **I/O isolation: 5,000 Vrms**
- **Operate current (typ/max): 1.2 mA / 3.0 mA** (current needed to turn the relay “on”)
- LED forward voltage (typ/max): 1.25 V / 1.5 V
- On resistance (typ/max): 0.85 Ω / 2.5 Ω

Resistor choice for 5V Pro Micro:

- Using **820 Ω** with a 5V GPIO yields roughly **~4–5 mA** LED current (depends on VF), which is above the **3 mA max** operate current and below absolute max LED current.

#### 0.3.3 PC817 (Optocoupler, DIP-4) ×1 (PowerSense)

- Function: detects PSU +5V presence while keeping PSU ground isolated from Arduino ground
- Package: DIP-4 (phototransistor output)
- Typical datasheet headline values (varies by bin):
    - Input-output isolation: **~5 kVrms**
    - CTR is specified by grade; common spec point is at **IF = 5 mA**
- This design uses the Pro Micro internal pullup on D6. Even a “low” CTR part generally provides more than enough collector current to pull an internal pullup LOW at these currents.

Resistor choice:

- Using **850 Ω** at 5V gives a few mA LED current (order of **~4–5 mA** depending on VF), chosen to make the opto pull-down robust without wasting power.

#### 0.3.4 H11AA1 (Optocoupler, DIP-6) ×1 (HDD LED sense)

- Function: polarity-insensitive sensing across HDD_LED header (bi-directional LED input)
- Package: DIP-6, phototransistor output, AC / polarity-insensitive input
- **Isolation test voltage: 5,300 Vrms**
- Minimum CTR: **20%** (device family characteristic)
- Input: two inverse-parallel IR LEDs → you can connect HDD_LED either way

Design note:

- Motherboard HDD_LED drive strengths vary. If you see no activity, the most common causes are:
    - wrong header (PWR_LED vs HDD_LED),
    - extremely low LED current drive,
    - very short pulses that require different filtering/thresholding.

#### 0.3.5 Resistors

- 2× **820 Ω** (AQY212EH input LEDs)
- 1× **850 Ω** (PC817 input LED)
- Recommendation for documentation clarity: note whether resistors are **±1%** or **±5%** (either is fine here).

#### 0.3.6 “OctoSwitch” naming

- If you previously referred to an “OctoSwitch” module: this design **does not** use any multi-channel switch module for PWR_SW/RESET_SW.
- If you bought an Amazon pack labeled “octoswitch” but containing **PC817** parts, treat those as the **PC817 optocouplers** for PowerSense.

---

## 1) Safety and “don’t do this” list

1. **Do not connect motherboard header ground to Arduino ground directly.**
    - PWR_SW and RESET_SW are isolated by AQY212EH.
    - HDD_LED is isolated by H11AA1.
2. **Do not connect SATA/Molex GND to Arduino GND directly** for PowerSense.
    - PowerSense is isolated by PC817.
3. **Do not feed SATA/Molex +5V into Pro Micro VCC/RAW.**
    - Pro Micro is powered from USB.
4. Breadboard rails are often **split** mid-board. Treat rails as _possibly disconnected_ unless you bridge them.
5. **OLED is on the Arduino power domain.** It is safe to share **Pro Micro VCC/GND** with the OLED _only if the OLED module is 5V-tolerant._

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
- **Minimum:** half-size (~400 tie-point) _can_ work, but wiring gets cramped.

---

## 4) Linear installation steps

### Step 1 — Place the Pro Micro

1. Insert the Pro Micro so it **straddles the center trench**.
2. Orient it with **USB connector pointing up**.
3. Confirm you can access these labeled pins:
    - `2`, `3`, `6`, `7`, `8`, `9`, `15`, and at least one `GND` and `VCC`.

---

### Step 2 — Establish Arduino-side ground and VCC rails

1. Choose one breadboard **ground rail** (e.g., top “–” rail) as **Arduino GND**.
2. Run a jumper from Pro Micro **GND** to that ground rail.
3. If that rail is split, add a jumper bridging the split so the entire rail is ground.
4. (Recommended) Choose one breadboard **+ rail** as **Arduino VCC**.
5. Run a jumper from Pro Micro **VCC** to that + rail.
6. If that rail is split, bridge the split.

> Arduino-side rails will be used for: OLED power, AQY212EH pin 2, PC817 pin 3, H11AA1 pin 4, and the override button return.

---

## 5) OLED Display (I²C) — D2/D3

Goal: drive the 4-pin OLED with **hardware I²C** on the Pro Micro.

### Step 3 — Wire OLED power

1. OLED **GND** → **Arduino GND rail**
2. OLED **VCC** → **Arduino VCC rail** (Pro Micro VCC)

### Step 4 — Wire OLED I²C

1. OLED **SDA** → Pro Micro **D2**
2. OLED **SCL** → Pro Micro **D3**

> Notes:
>
> - Many OLED modules include onboard pull-up resistors; do not add extra parts unless you observe flaky I²C behavior.
> - Keep SDA/SCL wires short to reduce noise.

---

## 6) PowerButton: PWR_SW via AQY212EH #1 (polarity-agnostic)

### Step 5 — Insert AQY212EH #1

1. Insert AQY212EH #1 **across the center trench** (so two pins on each side).
2. Orient it so you can reliably identify **pin 1** (notch/dot end).

### Step 6 — Wire AQY212EH #1 input (Arduino side)

1. Pro Micro **D9** → **820Ω** → AQY212EH #1 **pin 1**
2. AQY212EH #1 **pin 2** → **Arduino GND rail**

### Step 7 — Wire AQY212EH #1 output (Motherboard side)

1. Motherboard **PWR_SW** wire A → AQY212EH #1 **pin 3**
2. Motherboard **PWR_SW** wire B → AQY212EH #1 **pin 4**

**Polarity does not matter** on pins 3/4.

---

## 7) ResetButton: RESET_SW via AQY212EH #2 (polarity-agnostic)

### Step 8 — Insert AQY212EH #2

1. Insert AQY212EH #2 across the center trench.

### Step 9 — Wire AQY212EH #2 input (Arduino side)

1. Pro Micro **D8** → **820Ω** → AQY212EH #2 **pin 1**
2. AQY212EH #2 **pin 2** → **Arduino GND rail**

### Step 10 — Wire AQY212EH #2 output (Motherboard side)

1. Motherboard **RESET_SW** wire A → AQY212EH #2 **pin 3**
2. Motherboard **RESET_SW** wire B → AQY212EH #2 **pin 4**

**Polarity does not matter** on pins 3/4.

---

## 8) PowerSense: SATA/Molex +5V via PC817 → Pro Micro D6

Goal: detect whether PSU +5V is present, without tying PSU ground to Arduino ground.

### Step 11 — Insert PC817

1. Insert PC817 across the center trench (DIP-4).

### Step 12 — Wire PC817 input (PSU side)

1. SATA/Molex **+5V** → **850Ω** → PC817 **pin 1** (anode)
2. SATA/Molex **GND** → PC817 **pin 2** (cathode)

> This side is **PSU domain**. Do **not** connect PSU GND to Arduino GND elsewhere.

### Step 13 — Wire PC817 output (Arduino side)

1. PC817 **pin 3** (emitter) → **Arduino GND rail**
2. PC817 **pin 4** (collector) → Pro Micro **D6** (`POWER_SENSE_PIN`)

With `INPUT_PULLUP`:

- PC817 ON → D6 pulled LOW
- PC817 OFF → D6 reads HIGH

> Note: D6 does not need an interrupt for this use. This signal is typically slow-changing.

---

## 9) HardDriveLED: Motherboard HDD_LED via H11AA1 → Pro Micro D7 (polarity-agnostic)

Goal: detect HDD activity without caring about HDD_LED header polarity.

### Step 14 — Insert H11AA1

1. Insert H11AA1 across the center trench (DIP-6).
2. **Orient the notch up** so you can follow the pin map:
    - Left side top→bottom: pins **1,2,3**
    - Right side bottom→top: pins **4,5,6**

### Step 15 — Wire motherboard HDD_LED header (polarity does not matter)

1. Motherboard HDD_LED wire A → H11AA1 **pin 1**
2. Motherboard HDD_LED wire B → H11AA1 **pin 2**

Pin 3 is **NC** — leave it unconnected.

### Step 16 — Wire H11AA1 output to Arduino

1. H11AA1 **pin 4** (emitter) → **Arduino GND rail**
2. H11AA1 **pin 5** (collector) → Pro Micro **D7** (`HDD_SENSE_PIN`)

Leave **pin 6** (base) unconnected initially.

---

## 10) OverridePowerButton: local pushbutton to D15

### Step 17 — Wire override pushbutton (Arduino-side)

1. Place a momentary pushbutton anywhere convenient (Arduino side).
2. One side of the button → Pro Micro **D15**
3. Other side of the button → **Arduino GND rail**

Your sketch uses `INPUT_PULLUP` so no external resistor is needed.

---

## 11) Final connection summary (copy/paste checklist)

### OLED (I²C, 4-pin)

- OLED GND → Arduino GND rail
- OLED VCC → Arduino VCC rail (Pro Micro VCC)
- OLED SDA → D2
- OLED SCL → D3

### AQY212EH #1 (PWR_SW)

- D9 → 820Ω → AQY1 pin 1
- AQY1 pin 2 → Arduino GND
- Motherboard PWR_SW → AQY1 pins 3 & 4 (either order)

### AQY212EH #2 (RESET_SW)

- D8 → 820Ω → AQY2 pin 1
- AQY2 pin 2 → Arduino GND
- Motherboard RESET_SW → AQY2 pins 3 & 4 (either order)

### PC817 (PowerSense from SATA/Molex +5V)

- PSU +5V → 850Ω → PC817 pin 1
- PSU GND → PC817 pin 2
- PC817 pin 3 → Arduino GND
- PC817 pin 4 → D6

### H11AA1 (HDD_LED sense)

- Motherboard HDD_LED → H11AA1 pins 1 & 2 (either order)
- H11AA1 pin 4 → Arduino GND
- H11AA1 pin 5 → D7

### Override button (Arduino-side)

- Button between D15 and Arduino GND

---

## 12) Verification / troubleshooting (quick)

### 12.1 Confirm Pro Micro pins in Arduino IDE

- Ensure the board definition matches an ATmega32U4 board (Pro Micro / Leonardo / Micro).
- Confirm that “D2/D3/D6/D7/D8/D9/D15” correspond to the silkscreen pins you’re using.

### 12.2 Sanity checks with a multimeter

- Arduino GND rail continuity: Pro Micro GND ↔ rail should be ~0Ω.
- Arduino VCC rail continuity: Pro Micro VCC ↔ rail should be ~0Ω.
- PC817 LED side: diode-test across pins 1–2 should behave like a diode.

### 12.3 If OLED is blank

- Verify OLED VCC/GND are correct (OLED must share Arduino VCC/GND).
- Verify SDA→D2 and SCL→D3 are not swapped.
- Confirm your sketch is using the **hardware I²C** U8g2 constructor (not software I²C on other pins).

### 12.4 If PowerSense never changes

- Verify SATA/Molex +5V is actually present.
- Verify PC817 orientation (pin 1 at notch/dot end).
- Verify D6 configured as `INPUT_PULLUP`.

### 12.5 If HDD activity never triggers

- Verify H11AA1 notch orientation and pin numbering.
- Confirm motherboard HDD_LED header is the correct pins.
- Confirm D7 configured as `INPUT_PULLUP` and your sketch is actually reading/reporting it.

---

## 13) Notes on “OctoSwitch”

In this documentation, “OctoSwitch” is **not used for PWR_SW/RESET_SW** anymore. The **AQY212EH replaces that role** (and is what provides polarity independence for those switch headers).

---

## 14) Primary references (so you don’t have to hunt)

- AQY212EH specs (Panasonic Industrial Devices): https://na.industrial.panasonic.com/products/relays-contactors/semiconductor-relays/series/12428/model/12441
- AQY212EH listing (DigiKey): https://www.digikey.com/en/products/detail/panasonic-electric-works/AQY212EH/512405
- H11AA1 datasheet (DigiKey): https://www.digikey.com/en/htmldatasheets/production/1280241/0/0/1/h11aa1
- H11AA1 product page (Vishay): https://www.vishay.com/en/product/83608/
- PC817 datasheet (Sharp PDF): https://global.sharp/products/device/lineup/data/pdf/datasheet/PC817XxNSZ1B_e.pdf
