#include <Arduino.h>

// Define switch pin pairs
const int switchPins[3][2] = {
  {2, 3},  // Switch 1: connected between pins 2 and 3
  {4, 5},  // Switch 2: connected between pins 4 and 5
  {6, 7}   // Switch 3: connected between pins 6 and 7
};

bool lastSwitchStates[3] = {false, false, false};  // Last states of the switches

void setup() {
  Serial.begin(9600);
  // Initialize all switch pins as INPUT_PULLUP
  for (int i = 0; i < 3; i++) {
    pinMode(switchPins[i][0], INPUT_PULLUP);
    pinMode(switchPins[i][1], INPUT_PULLUP);
  }
}

void loop() {
  // Check each switch
  for (int i = 0; i < 3; i++) {
    // Read the current state of the switch
    bool currentSwitchState = !digitalRead(switchPins[i][0]) && !digitalRead(switchPins[i][1]);

    // Check if the state has changed from the last iteration
    if (currentSwitchState != lastSwitchStates[i]) {
      lastSwitchStates[i] = currentSwitchState;  // Update the last state
    }
  }

  // Handle serial commands
  if (Serial.available() > 0) {
    String input = Serial.readStringUntil('\n');
    input.trim();

    if (input == "identify") {
      Serial.println("AC");
    } else if (input.startsWith("hold ")) {
      int switchNum = input.substring(5).toInt() - 1;
      if (switchNum >= 0 && switchNum < 3) {
        Serial.print("Pressing switch ");
        Serial.println(switchNum + 1);
        // Set both pins of the switch to OUTPUT and LOW to simulate holding
        pinMode(switchPins[switchNum][0], OUTPUT);
        pinMode(switchPins[switchNum][1], OUTPUT);
        digitalWrite(switchPins[switchNum][0], LOW);
        digitalWrite(switchPins[switchNum][1], LOW);
      }
    } else if (input.startsWith("release ")) {
      int switchNum = input.substring(8).toInt() - 1;
      if (switchNum >= 0 && switchNum < 3) {
        Serial.print("Releasing switch ");
        Serial.println(switchNum + 1);
        // Set both pins of the switch back to INPUT_PULLUP to simulate releasing
        pinMode(switchPins[switchNum][0], INPUT_PULLUP);
        pinMode(switchPins[switchNum][1], INPUT_PULLUP);
      }
    }
  }

  delay(100);  // Add a small delay to reduce serial output rate
}
