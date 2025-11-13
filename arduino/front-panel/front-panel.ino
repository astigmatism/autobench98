#include <Arduino.h>

// Define pins for power, reset buttons, and power LED
#define ID "FP"
#define POWER_SENSE_PIN 2
#define POWER_BUTTON_PIN 3
#define RESET_BUTTON_PIN 4
#define OVERRIDE_POWER_BUTTON_PIN 5
#define DEBOUNCE_DELAY 500 // debounce time in milliseconds

bool isIdentified = false;
bool powerButtonlock = false;  // Lock to prevent interference
bool commandLock = false;  // Lock to prevent interference
volatile unsigned long lastPowerLEDInterruptTime = 0;
volatile bool powerLedStateChanged = false;  // Flag to indicate a state change
bool powerButtonHeld = false;  // Tracks if power button is held

void setup() {
  // Initialize serial communication
  Serial.begin(9600);

  // Configure button pins and LED pin
  pinMode(POWER_BUTTON_PIN, OUTPUT);
  pinMode(RESET_BUTTON_PIN, OUTPUT);  // Set reset button pin as output (inverted logic)
  pinMode(POWER_SENSE_PIN, INPUT_PULLUP);
  pinMode(OVERRIDE_POWER_BUTTON_PIN, INPUT_PULLUP);

  // Ensure buttons are not pressed by default (set LOW to simulate unpressed state with inverted logic)
  digitalWrite(POWER_BUTTON_PIN, LOW);
  digitalWrite(RESET_BUTTON_PIN, LOW);  // Default is LOW (inactive)

  // Attach interrupt to the power LED pin
  attachInterrupt(digitalPinToInterrupt(POWER_SENSE_PIN), handlePowerLedChange, CHANGE);
}

void handlePowerLedChange() {
    lastPowerLEDInterruptTime = millis();
    powerLedStateChanged = true;
}

void loop() {

    // Process Serial Commands
    if (Serial.available()) {
        commandLock = true;
        String command = Serial.readStringUntil('\n');
        command.trim(); // Clean up the command string

        // Command processing
        if (command == "identify") {
          isIdentified = false;
          Serial.println(ID);
        } else if (!isIdentified && command == "identify_complete") {
          isIdentified = true;
          Serial.println("debug: front panel identification complete, sending client power state");
          bool pcPowerOn = (digitalRead(POWER_SENSE_PIN) == LOW);  // Original logic, unchanged
          Serial.println("POWER_LED_" + (pcPowerOn ? String("ON") : String("OFF")));
        } else if (isIdentified && command == "POWER_HOLD") {
            holdPowerButton();  // Hold the power button
            Serial.println("debug: front panel power button held");
        } else if (isIdentified && command == "POWER_RELEASE") {
            releasePowerButton();  // Release the power button
            Serial.println("debug: front panel power button released");
        } else if (isIdentified && command == "RESET_HOLD") {
            simulateButtonPress(RESET_BUTTON_PIN);  // Press the reset button momentarily
            Serial.println("debug: front panel reset button held");
        } else if (isIdentified && command == "RESET_RELEASE") {
            Serial.println("debug: front panel reset button released");
        }
    }

    // Handle Power LED state changes
    else if (isIdentified && !commandLock && powerLedStateChanged && ((millis() - lastPowerLEDInterruptTime) > DEBOUNCE_DELAY)) {
      bool pcPowerOn = (digitalRead(POWER_SENSE_PIN) == LOW);  // Original logic, unchanged
      Serial.println("POWER_LED_" + (pcPowerOn ? String("ON") : String("OFF")));
      powerLedStateChanged = false;
    } 
    
    // Handle Override Button with non-blocking debounce
    else if (isIdentified && !commandLock && !powerButtonlock && digitalRead(OVERRIDE_POWER_BUTTON_PIN) == LOW) {
      // Simulate pressing the power button
      simulateButtonPress(POWER_BUTTON_PIN);
    }

    commandLock = false;
}

// Simulate a momentary button press with inverted logic
void simulateButtonPress(int buttonPin) {
  digitalWrite(buttonPin, HIGH);  // Inverted logic: Press the button (open the circuit)
  delay(100);                     // Hold the press for a short time
  digitalWrite(buttonPin, LOW);   // Release the button (close the circuit)
}

// Hold the power button (inverted logic)
void holdPowerButton() {
  digitalWrite(POWER_BUTTON_PIN, HIGH);  // Inverted logic: Hold the power button
  powerButtonHeld = true;  // Track that the button is held
}

// Release the power button (inverted logic)
void releasePowerButton() {
  if (powerButtonHeld) {
    digitalWrite(POWER_BUTTON_PIN, LOW);  // Release the button
    powerButtonHeld = false;  // Reset the held state
  }
}
