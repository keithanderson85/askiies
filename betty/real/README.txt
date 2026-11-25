Put your own "Bitchin' Betty" recordings in this folder. Any you add replace the generated
voice for that warning; anything missing keeps using the generated clip one folder up.

Name each file exactly like this (.mp3, .wav or .ogg all work):

  pull     "Pull up. Pull up."
  msl      "Missile. Missile."
  launch   "Missile launch."
  fire     "Engine fire."
  stall    "Stall. Stall."
  alt      "Altitude. Altitude."
  bank     "Bank angle. Bank angle."
  warn     "Warning. Warning."
  over     "Overspeed."
  g        "Over G."
  bingo    "Winchester."  (out of missiles)
  lock     "Enemy lock."
  c1 .. c12  "One o'clock" .. "Twelve o'clock" (said after "Missile")

Real clips play as they are (no radio filter). Then rebuild: docker compose up -d --build
