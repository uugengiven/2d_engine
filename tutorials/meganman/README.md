This will be a megaman type game that will serve as a base tutorial for creating a game.

Quick info for building this:

The character spritesheet is split between two files:
./sprites/chibi-robot.png
./sprites/chibi-robot-extended.png

Both have cells that are 34x35 pixels, with the character facing right, and have the following indexes:

chibi-robot.png
run [0, 1, 2, 3, 4, 5]
idle [6]
jump [7,8]
fall [9]
shoot [10]
run_shoot [11, 12, 13, 14, 15, 16, 17]
charge_shot [17, 18]
front [19]
back [20]
climb [21, 22, 23, 24]
hurt [25, 26]

Chibi-robot-extended.png
idle [0] (repeat of frame id 6 above)
fly [1, 2]
vertical_jump [3]
vertical_shoot [4]
vertical_fall [5]
vertical_fall_shoot [6]
wall_slide [7] (against left wall)
wall_slide_shoot [8]
victory_post [9, 10]
crouch [11]
crouch_shoot [12]
slide [13, 14]
climb_shoot [15]
dash [16]
dash_shoot [17]
lay [18]
crawl [19, 20, 21, 22]

The tileset for levels is ./sprites/tileset.png with 16x16 tiles

I can give more of the tilemap, but the important bits to start are

ground_a_tl [39]
ground_a_tc [40]
ground_a_tr [41]
ground_a_ml [48]
ground_a_mc [49]
ground_a_mr [50]

And there is a background plane called /sprites/bg.png that is horizontally tileable. It is 160x240


The game should allow the following:

Moving left and right
Jumping, with some air control
Firing the direction being faced
Character stands on the ground
The tile map has both foreground and background tiles
Tiles have collision, though some allow for jumping up through, so only collision from above and sides
Level scrolls primarily left to right but with vertical scrolling allowed
Scrolling is smooth and keeps the character in a safe scroll area without locking the camera exactly to the character

Enemies and other features to follow