# Composes the "W2 varied rooms" keep base image from the source packs.
# Sources are read-only; output goes next to this script. Re-run to reproduce.
# Output: w2-keep-base-1x.png (672x576) and w2-keep-base-2x.png (1344x1152), plus w2-rooms.json (room rects at 2x).
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$tp = Join-Path (Split-Path -Parent $here) "Tile Pack"
$pc = "$tp\Pixel Crawler - Free Pack\Environment"
$src = @{
  dungeon = "$pc\Tilesets\Dungeon_Tiles.png"; floors = "$pc\Tilesets\Floors_Tiles.png"
  workbench = "$pc\Structures\Stations\Workbench\Workbench.png"; anvil = "$pc\Structures\Stations\Anvil\Anvil.png"; furnace = "$pc\Structures\Stations\Furnace\Furnace.png"
  furniture = "$pc\Props\Static\Furniture.png"
  int16 = "$tp\Modern tiles_Free\Interiors_free\16x16\Interiors_free_16x16.png"; room = "$tp\Modern tiles_Free\Interiors_free\16x16\Room_Builder_free_16x16.png"
  apt = "$tp\png\apartmentA5demo.png"; chest = "$tp\Top_Down_Adventure_Pack_v.1.0\Props_Items_(animated)\lootchest_item_anim_strip_8.png"
}
$bmp = @{}; foreach ($k in $src.Keys) { $bmp[$k] = [System.Drawing.Bitmap]::FromFile($src[$k]) }

# Adaptation: Modern/apartment art is bright daylight. Darken and cool it so it sits in dungeon light.
$dim = New-Object System.Drawing.Imaging.ImageAttributes
$m = New-Object System.Drawing.Imaging.ColorMatrix; $m.Matrix00 = 0.66; $m.Matrix11 = 0.70; $m.Matrix22 = 0.80; $m.Matrix33 = 1; $m.Matrix44 = 1
$dim.SetColorMatrix($m)

# v3 (cycle 2): one continuous building. 48 px perimeter, dark stone ground, full-width halls,
# outer wall ring, south gate, and carved (unlit) rune channels from the core. Room coordinates
# below are written for the inner 672x576 keep and translated by the perimeter.
$M = 48
$W = 672 + 2 * $M; $H = 576 + 2 * $M
$canvas = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($canvas); $g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
$g.Clear([System.Drawing.Color]::FromArgb(255, 1, 7, 14))
$deep = New-Object System.Drawing.Imaging.ImageAttributes
$m2 = New-Object System.Drawing.Imaging.ColorMatrix; $m2.Matrix00 = 0.42; $m2.Matrix11 = 0.46; $m2.Matrix22 = 0.54; $m2.Matrix33 = 1; $m2.Matrix44 = 1
$deep.SetColorMatrix($m2)
# dark stone ground across the whole keep (the "between" is part of the building, not void)
for ($y = 0; $y -lt $H; $y += 48) { for ($x = 0; $x -lt $W; $x += 48) { $g.DrawImage($bmp["floors"], (New-Object System.Drawing.Rectangle $x, $y, 48, 48), 256, 16, 48, 48, [System.Drawing.GraphicsUnit]::Pixel, $deep) } }
# outer wall ring (top row as wall faces; sides and bottom as a thick dark rim with columns)
for ($x = 0; $x -lt $W; $x += 48) { $g.DrawImage($bmp["dungeon"], (New-Object System.Drawing.Rectangle $x, 0, 48, 48), 0, 0, 48, 48, [System.Drawing.GraphicsUnit]::Pixel) }
$rim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 8, 14, 20))
$g.FillRectangle($rim, 0, 48, 16, $H - 48); $g.FillRectangle($rim, $W - 16, 48, 16, $H - 48); $g.FillRectangle($rim, 0, $H - 16, $W, 16)
for ($y = 48; $y -lt $H - 16; $y += 48) { $g.DrawImage($bmp["dungeon"], (New-Object System.Drawing.Rectangle 0, $y, 16, 48), 48, 16, 16, 48, [System.Drawing.GraphicsUnit]::Pixel); $g.DrawImage($bmp["dungeon"], (New-Object System.Drawing.Rectangle ($W - 16), $y, 16, 48), 48, 16, 16, 48, [System.Drawing.GraphicsUnit]::Pixel) }
# south gate in the rim
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 1, 7, 14))), ($W / 2 - 24), ($H - 16), 48, 16)
$g.TranslateTransform($M, $M)
# full-width halls between rooms (lit stone-brick, lighter than the ground)
for ($x = 0; $x -lt 672; $x += 48) { foreach ($hy in 160, 368) { $g.DrawImage($bmp["floors"], (New-Object System.Drawing.Rectangle $x, $hy, 48, 48), 256, 16, 48, 48, [System.Drawing.GraphicsUnit]::Pixel) } }
for ($y = 0; $y -lt 576; $y += 48) { foreach ($hx in 192, 432) { $g.DrawImage($bmp["floors"], (New-Object System.Drawing.Rectangle $hx, $y, 48, 48), 256, 16, 48, 48, [System.Drawing.GraphicsUnit]::Pixel) } }
# carved rune channels (unlit) from the core room out along the halls; a live layer lights them
$chan = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 28, 40))
$g.FillRectangle($chan, 0, 182, 672, 4); $g.FillRectangle($chan, 0, 390, 672, 4); $g.FillRectangle($chan, 214, 0, 4, 576); $g.FillRectangle($chan, 454, 0, 4, 576)
# hall ambience: candles and plants set into the halls
foreach ($p in @(@(200, 120), @(440, 120), @(200, 520), @(440, 520))) { $g.DrawImage($bmp["dungeon"], (New-Object System.Drawing.Rectangle $p[0], $p[1], 16, 48), 64, 112, 16, 48, [System.Drawing.GraphicsUnit]::Pixel) }

function Put($key, $sx, $sy, $sw, $sh, $dx, $dy, [switch]$Adapt) {
  $dest = New-Object System.Drawing.Rectangle $dx, $dy, $sw, $sh
  if ($Adapt) { $g.DrawImage($bmp[$key], $dest, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel, $dim) }
  else { $g.DrawImage($bmp[$key], $dest, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel) }
}
function Tile($key, $sx, $sy, $tw, $th, $rx, $ry, $rw, $rh, [switch]$Adapt) {
  for ($y = $ry; $y -lt $ry + $rh; $y += $th) { for ($x = $rx; $x -lt $rx + $rw; $x += $tw) {
    $w = [Math]::Min($tw, $rx + $rw - $x); $h = [Math]::Min($th, $ry + $rh - $y)
    if ($Adapt) { Put $key $sx $sy $w $h $x $y -Adapt } else { Put $key $sx $sy $w $h $x $y } } }
}
$RW = 192; $RH = 160; $GAP = 48
$cols = @(0, 240, 480); $rows = @(0, 208, 416)

# corridors are the full-width halls drawn above

function Room($rx, $ry, $floorKey, $fx, $fy, $fw, $fh, [switch]$AdaptFloor, [switch]$Plaster) {
  if ($AdaptFloor) { Tile $floorKey $fx $fy $fw $fh $rx ($ry + 48) $RW ($RH - 48) -Adapt } else { Tile $floorKey $fx $fy $fw $fh $rx ($ry + 48) $RW ($RH - 48) }
  Tile dungeon 0 0 48 48 $rx $ry $RW 48
  if ($Plaster) { Tile room 0 80 48 32 $rx ($ry + 8) $RW 32 -Adapt }
}

# ---- rooms ----
$names = @{}
# Library (Events) - top left
Room 0 0 room 64 208 48 16 -AdaptFloor
Put int16 160 1094 96 34 48 12 -Adapt; Put int16 80 224 32 64 4 40 -Adapt; Put int16 80 224 32 64 156 40 -Adapt
Put int16 121 618 28 22 44 116 -Adapt; Put int16 121 647 28 25 120 113 -Adapt; Put int16 209 577 13 21 90 122 -Adapt
$names["Events"] = @(0, 0)
# Council hall (Approvals) - top centre
Room 240 0 room 176 208 48 32 -AdaptFloor
Put int16 13 161 38 37 282 84 -Adapt; Put int16 93 161 38 37 360 84 -Adapt
Put int16 146 497 13 21 266 94 -Adapt; Put int16 146 497 13 21 400 94 -Adapt; Put int16 162 497 13 21 330 124 -Adapt
Put int16 167 713 18 31 244 50 -Adapt; Put int16 167 713 18 31 410 50 -Adapt
$names["Approvals"] = @(240, 0)
# War room (Goals) - top right
Room 480 0 room 64 208 48 16 -AdaptFloor
Put dungeon 80 160 32 64 496 4; Put dungeon 80 160 32 64 624 4
Put int16 13 161 38 37 557 86 -Adapt; Put int16 160 1068 32 16 560 94 -Adapt; Put int16 146 497 13 21 540 96 -Adapt; Put int16 162 497 13 21 598 96 -Adapt
$names["Goals"] = @(480, 0)
# Researcher workshop - middle left
Room 0 208 dungeon 64 0 48 48
Put workbench 112 115 80 61 56 250; Put anvil 80 36 79 56 104 300; Put furniture 736 165 32 27 6 300
$names["Researcher"] = @(0, 208)
# Command room (runtime core) - centre
Room 240 208 dungeon 64 0 48 48
Put dungeon 112 0 48 48 312 280
Put apt 17 224 30 16 262 222 -Adapt; Put apt 17 224 30 16 331 222 -Adapt; Put apt 17 224 30 16 400 222 -Adapt
Put anvil 96 132 48 28 312 336
Put apt 16 129 32 31 256 262 -Adapt; Put apt 16 129 32 31 392 262 -Adapt
Put apt 16 182 32 24 256 300 -Adapt; Put apt 16 182 32 24 392 300 -Adapt
Put apt 86 179 20 28 246 334 -Adapt; Put apt 86 179 20 28 414 334 -Adapt
$names["Runtime"] = @(240, 208)
# Publisher workshop - middle right
Room 480 208 floors 256 16 48 48
Put anvil 176 14 96 82 528 246; Put workbench 48 115 48 45 488 312
$names["Publisher"] = @(480, 208)
# Engine room (Workflows) - bottom left
Room 0 416 dungeon 112 160 32 32
Put furnace 112 68 77 124 8 440; Put workbench 103 64 73 48 104 468
$names["Workflows"] = @(0, 416)
# Entrance hall - bottom centre
Room 240 416 floors 256 16 48 48
Put furniture 83 432 58 32 254 500; Put furniture 83 432 58 32 370 500
Put dungeon 80 96 32 32 268 424; Put dungeon 80 96 32 32 380 424; Put dungeon 64 112 16 48 324 460; Put dungeon 64 112 16 48 348 460
$names["Entrance"] = @(240, 416)
# Vault (Artifacts) - bottom right
Room 480 416 room 64 208 48 16 -AdaptFloor
Put int16 114 772 27 39 490 456 -Adapt; Put int16 114 820 27 39 522 456 -Adapt; Put int16 114 772 27 39 554 456 -Adapt; Put int16 114 820 27 39 586 456 -Adapt; Put furniture 736 165 32 27 628 462
Put chest 0 0 16 16 520 530; Put chest 0 0 16 16 548 530; Put chest 0 0 16 16 576 530
$names["Artifacts"] = @(480, 416)

$g.Dispose()
$canvas.Save("$here\w2-keep-base-1x.png", [System.Drawing.Imaging.ImageFormat]::Png)
$big = New-Object System.Drawing.Bitmap ($W * 2), ($H * 2); $gg = [System.Drawing.Graphics]::FromImage($big); $gg.InterpolationMode = 'NearestNeighbor'; $gg.PixelOffsetMode = 'Half'
$gg.DrawImage($canvas, 0, 0, $W * 2, $H * 2); $gg.Dispose()
$big.Save("$here\w2-keep-base-2x.png", [System.Drawing.Imaging.ImageFormat]::Png)
$rooms = @{}; foreach ($k in $names.Keys) { $rooms[$k] = @{ x = ($names[$k][0] + $M) * 2; y = ($names[$k][1] + $M) * 2; w = $RW * 2; h = $RH * 2 } }
$rooms | ConvertTo-Json | Set-Content -Encoding utf8 "$here\w2-rooms.json"
$big.Dispose(); $canvas.Dispose(); foreach ($b in $bmp.Values) { $b.Dispose() }
"composed w2 keep"
