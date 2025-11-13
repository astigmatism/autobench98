#include <ps2dev.h>
#include <EEPROM.h>

#define ID "MS"
#define PS2_CLOCK_PIN 3
#define PS2_DATA_PIN 2
#define POWER_STATUS_PIN 5

PS2dev mouse(PS2_CLOCK_PIN, PS2_DATA_PIN);

bool isIdentified = false;
bool isInitialized = false;
bool isPCPoweredOn = false;
bool lastPowerStatus = false;
bool isReporting = false; // enabled via PS2 command, not sure about it

char buttons[3] = {0, 0, 0};
int delta_x = 0;
int delta_y = 0;
int enabled = 0;
int last_x = 0;
int last_y = 0;

void setup() {
  Serial.begin(9600);
  Serial.flush();
  pinMode(PS2_CLOCK_PIN, INPUT_PULLUP);
  pinMode(PS2_DATA_PIN, INPUT_PULLUP);
  pinMode(POWER_STATUS_PIN, INPUT_PULLUP);
}

void loop() {
  // Check the power status
  bool currentPowerStatus = digitalRead(POWER_STATUS_PIN) == HIGH;
  if (currentPowerStatus != lastPowerStatus) {
    if (currentPowerStatus) {
      isPCPoweredOn = true;
      Serial.println("debug: mouse accepts power ON command from keyboard simulator");
    } else {
      isPCPoweredOn = false;
      isInitialized = false; // Reset initialization status on power off
      Serial.println("debug: mouse accepts power OFF command from keyboard simulator");
    }
    lastPowerStatus = currentPowerStatus;
  }

  // Process Serial Commands
  if (Serial.available()) {
    String command = Serial.readStringUntil('\n');
    command.trim();
    if (command == "identify") {
      isIdentified = false;
      Serial.println(ID);
    } else if (!isIdentified && command == "identify_complete") {
      isIdentified = true;
      Serial.println("debug: mouse identification complete");
    } else if (isIdentified && isPCPoweredOn) { 
      if (command.startsWith("MOVE ")) {
        int commaIndex = command.indexOf(',');
        int new_x = command.substring(5, commaIndex).toInt();
        int new_y = command.substring(commaIndex + 1).toInt();

        // Calculate the deltas
        delta_x = new_x - last_x;
        delta_y = new_y - last_y;

        // Clamp the deltas to the range -255 to 255
        if (delta_x > 255) delta_x = 255;
        if (delta_x < -255) delta_x = -255;
        if (delta_y > 255) delta_y = 255;
        if (delta_y < -255) delta_y = -255;

        // Update the last position
        last_x = new_x;
        last_y = new_y;

        if (isReporting && (delta_x != 0 || delta_y != 0)) {
          // Serial.println("debug: mouse moved to (" + String(new_x) + ", " + String(new_y) + ")");
          // Serial.println("debug: delta_x = " + String(delta_x) + ", delta_y = " + String(delta_y));
          write_packet();
        }
      } else if (command.startsWith("CLICK ")) {
        int button = command.substring(6).toInt();
        if (button >= 0 && button < 3) { // Ensure button index is within range
          buttons[button] = 1; // Press the button
          write_packet();
          Serial.println("debug: mouse button " + String(button) + " held");
        }
      } else if (command.startsWith("RELEASE ")) {
        int button = command.substring(8).toInt();
        buttons[button] = 0; // Release the button
        write_packet();
        Serial.println("debug: mouse button " + String(button) + " released");
      }
    }
    // once identified, inform any serial commands have comepleted to prevent flooding
    if (isIdentified) {
      Serial.println("done: with command " + String(command));
    }
  }

  // Monitor the PS/2 clock line to detect communication from the host
  if ((digitalRead(PS2_CLOCK_PIN) == LOW || digitalRead(PS2_DATA_PIN) == LOW) && isPCPoweredOn) {
    handlePS2Communication();
  }
}

void handlePS2Communication() {
  unsigned char command;
  // Serial.println("debug: mouse reading input...");
  if (mouse.read(&command) == 0) { // ensures that the read operation was successful and that the command variable contains a valid command
    // Serial.println("debug: ...mouse read " + String(command));
    mouse_command(command);
  } else {
    // Serial.println("debug: ...mouse read meh");
  }
}

void mouse_command(unsigned char command) {
  unsigned char val;
  switch (command) {
    case 0xFF: // Reset
      ack();
      while (mouse.write(0xAA) != 0); // Self-test passed
      while (mouse.write(0x00) != 0); // Mouse ID
      isInitialized = true; // Mark initialization as complete
      Serial.println("debug: mouse sent reset");
      break;
    case 0xFE: // Resend
      ack();
      Serial.println("debug: mouse sent resend");
      break;
    case 0xF6: // Set defaults
      ack();
      Serial.println("debug: mouse sent set defaults");
      break;
    case 0xF5: // Disable data reporting
      isReporting = false;
      ack();
      Serial.println("debug: mouse sent disable data reporting");
      break;
    case 0xF4: // Enable data reporting
      isReporting = true;
      ack();
      Serial.println("debug: mouse sent enable data reporting");
      break;
    case 0xF3: // Set sample rate
      ack();
      if (mouse.read(&val) == 0) { // Read the sample rate value
        ack();
      }
      Serial.println("debug: mouse sent set sample rate");
      break;
    case 0xF2: // Get device ID
      ack();
      mouse.write(0x00); // Mouse ID
      Serial.println("debug: mouse sent ps2 identify");
      break;
    case 0xF0: // Set remote mode
      ack();
      Serial.println("debug: mouse sent remote mode");
      break;
    case 0xEE: // Set wrap mode
      ack();
      Serial.println("debug: mouse sent set wrap mode");
      break;
    case 0xEC: // Reset wrap mode
      ack();
      Serial.println("debug: mouse sent reset wrap mode");
      break;
    case 0xEB: // Read data
      ack();
      write_packet(); // Send a data packet
      Serial.println("debug: mouse sent read data");
      break;
    case 0xEA: // Set stream mode
      ack();
      Serial.println("debug: mouse sent set stream mode");
      break;
    case 0xE9: // Status request
      ack();
      send_status(); // Send status packet
      Serial.println("debug: mouse sent status");
      break;
    case 0xE8: // Set resolution
      ack();
      if (mouse.read(&val) == 0) { // Read the resolution value
        ack();
      }
      Serial.println("debug: mouse sent resolution");
      break;
    case 0xE7: // Set scaling 2:1
      ack();
      Serial.println("debug: mouse sent scaling 2:1");
      break;
    case 0xE6: // Set scaling 1:1
      ack();
      break;
    default:
      mouse.write(0xFE); // Resend if unknown command
      Serial.println("debug: mouse sent command was unknown");
      break;
  }
}

void write_packet() {
  char overflowx = 0;
  char overflowy = 0;
  char data[3];
  int x, y;

  if (delta_x > 255) {
    overflowx = 1;
    x = 255;
  } else if (delta_x < -255) {
    overflowx = 1;
    x = -255;
  } else {
    x = delta_x;
  }

  if (delta_y > 255) {
    overflowy = 1;
    y = 255;
  } else if (delta_y < -255) {
    overflowy = 1;
    y = -255;
  } else {
    y = delta_y;
  }

  data[0] = ((overflowy & 1) << 7) |
            ((overflowx & 1) << 6) |
            ((((y & 0x100) >> 8) & 1) << 5) |
            ((((x & 0x100) >> 8) & 1) << 4) |
            ((1) << 3) |
            ((buttons[1] & 1) << 2) |
            ((buttons[2] & 1) << 1) |
            ((buttons[0] & 1) << 0);

  data[1] = x & 0xff;
  data[2] = y & 0xff;

  mouse.write(data[0]);
  mouse.write(data[1]);
  mouse.write(data[2]);

  delta_x = 0;
  delta_y = 0;
}

void ack() {
  while (mouse.write(0xFA) != 0);
}

void send_status() {
  unsigned char status[] = {0x00, 0x00, 0x00}; // Basic status packet (modify as needed)
  mouse.write(status[0]);
  mouse.write(status[1]);
  mouse.write(status[2]);
}
