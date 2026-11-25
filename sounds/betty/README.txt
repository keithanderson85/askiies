Real cockpit sounds. Drop recordings in this folder (mp3, wav, ogg or m4a), rebuild
(docker compose up -d --build), and set OPTIONS > GAMEPLAY > VOICE WARNINGS to REAL.

The game picks each file by words in its name (capitals and punctuation don't matter):

  VOICE ("Betty")                          name must contain
  Pull up. Pull up.                        pull up
  Missile. Missile.                        missile
  Missile launch.                          missile launch   (or launch)
  Engine fire.                             fire
  Stall. Stall.                            stall
  Altitude. Altitude.                      altitude
  Bank angle.                              bank angle
  Warning. Warning.                        warning
  Overspeed.                               overspeed
  Over G.                                  over g
  Bingo (low fuel)                         bingo   (or fuel)
  Winchester (out of missiles)             winchester
  Enemy lock.                              lock
  "Six o'clock" etc. (after "Missile")     6 o clock / six o'clock

  TONES
  Caution chime before caution calls       deedle   (or caution / chime)
  RWR, new radar contact                   rwr new  (or rwr contact)
  RWR, locked on you (loops)               rwr lock
  RWR, missile launched (loops)            rwr launch  (or rwr missile)
  RWR compilation (RWR.mp3)                rwr   -> new contact 0.30-0.78 s, lock 2.60-8.03 s,
                                                    launch 9.00-13.60 s (set in combat-alerts.js RWR_MAP)

Anything missing uses the generated voice (betty/). Real clips play exactly as recorded.
