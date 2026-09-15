# Keep v4 (cycle 3): tighter, non-grid composition.
# - Larger central command room (240x176) with side rooms 176 wide; top/bottom rows 128 tall.
# - Halls are 24 px (1.5 tiles) instead of 48, so the whole keep fits the default viewport at 2x
#   and every state-carrying room is visible without panning.
# - 16 px perimeter rim with a gate gap at the bottom.
# Sources are read-only. Output: keep-v4-1x.png (672x512), keep-v4-2x.png (1344x1024), keep-v4-rooms.json.
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
function Attr($r, $g, $b) { $a = New-Object System.Drawing.Imaging.ImageAttributes; $m = New-Object System.Drawing.Imaging.ColorMatrix; $m.Matrix00 = $r; $m.Matrix11 = $g; $m.Matrix22 = $b; $m.Matrix33 = 1; $m.Matrix44 = 1; $a.SetColorMatrix($m); $a }
$dim = Attr 0.66 0.70 0.80      # Modern/apartment art into dungeon light
$deep = Attr 0.40 0.44 0.52     # ground between rooms

# cycle 4: the rim is wider left/right (PX) so the keep fills a 1440 px viewport at 2x with no letterbox gutters
$embers = Attr 0.55 0.30 0.30   # the forge fire is not state; it shows as dark embers, not a glow
$slate = Attr 0.92 0.74 0.80    # the command room floor is shifted from teal to slate so cyan stays unique to "active"
$stoneDim = Attr 0.72 0.72 0.76 # pale stone floors would read as lit
$P = 16; $PX = 40; $IW = 640; $IH = 480
$W = $IW + 2 * $PX; $H = $IH + 2 * $P
$canvas = New-Object System.Drawing.Bitmap $W, $H
$g = [System.Drawing.Graphics]::FromImage($canvas); $g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
$g.Clear([System.Drawing.Color]::FromArgb(255, 1, 7, 14))
function Put($key, $sx, $sy, $sw, $sh, $dx, $dy, $attr) {
  $dest = New-Object System.Drawing.Rectangle $dx, $dy, $sw, $sh
  if ($attr) { $g.DrawImage($bmp[$key], $dest, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel, $attr) } else { $g.DrawImage($bmp[$key], $dest, $sx, $sy, $sw, $sh, [System.Drawing.GraphicsUnit]::Pixel) }
}
function Tile($key, $sx, $sy, $tw, $th, $rx, $ry, $rw, $rh, $attr) {
  for ($y = $ry; $y -lt $ry + $rh; $y += $th) { for ($x = $rx; $x -lt $rx + $rw; $x += $tw) {
    Put $key $sx $sy ([Math]::Min($tw, $rx + $rw - $x)) ([Math]::Min($th, $ry + $rh - $y)) $x $y $attr } }
}
# ground and rim
Tile floors 256 16 48 48 0 0 $W $H $deep
$rim = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 10, 16, 22))
$rimEdge = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 36, 48, 60))
$g.FillRectangle($rim, 0, 0, $W, $P); $g.FillRectangle($rim, 0, $H - $P, $W, $P); $g.FillRectangle($rim, 0, 0, $PX, $H); $g.FillRectangle($rim, $W - $PX, 0, $PX, $H)
# rampart columns fill the wide side rims
for ($y = $P; $y -lt $H - $P; $y += 48) { foreach ($colX in @(12, ($W - 28))) { Put dungeon 48 16 16 48 $colX $y } }
$g.FillRectangle($rimEdge, $PX - 2, $P - 2, $W - 2 * $PX + 4, 2); $g.FillRectangle($rimEdge, $PX - 2, $H - $P, $W - 2 * $PX + 4, 2)
$g.FillRectangle($rimEdge, $PX - 2, $P - 2, 2, $H - 2 * $P + 4); $g.FillRectangle($rimEdge, $W - $PX, $P - 2, 2, $H - 2 * $P + 4)
$g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 1, 7, 14))), ($W / 2 - 24), ($H - $P), 48, $P)   # gate
$g.TranslateTransform($PX, $P)

$cx = @(0, 200, 464); $cw = @(176, 240, 176)
$ry = @(0, 152, 352); $rh = @(128, 176, 128)
# halls (24 px) lit stone-brick
Tile floors 256 16 48 48 0 128 $IW 24; Tile floors 256 16 48 48 0 328 $IW 24
Tile floors 256 16 48 48 176 0 24 $IH; Tile floors 256 16 48 48 440 0 24 $IH
function Room($c, $r, $floorKey, $fx, $fy, $fw, $fh, $attr) {
  $x = $cx[$c]; $y = $ry[$r]; $w = $cw[$c]; $h = $rh[$r]
  Tile $floorKey $fx $fy $fw $fh $x ($y + 48) $w ($h - 48) $attr
  Tile dungeon 0 0 48 48 $x $y $w 48
}
# Library (Events)
Room 0 0 room 64 208 48 16 $dim
Put int16 160 1094 96 34 40 10 $dim; Put int16 80 224 32 64 2 44 $dim; Put int16 80 224 32 64 142 44 $dim
Put int16 121 618 28 22 44 96 $dim; Put int16 121 647 28 25 104 94 $dim; Put int16 209 577 13 21 82 100 $dim
# Council hall (Approvals)
Room 1 0 room 176 208 48 32 $dim
Put int16 13 161 38 37 260 64 $dim; Put int16 93 161 38 37 342 64 $dim
Put int16 146 497 13 21 244 74 $dim; Put int16 146 497 13 21 382 74 $dim; Put int16 162 497 13 21 314 100 $dim
Put int16 167 713 18 31 204 52 $dim; Put int16 167 713 18 31 418 52 $dim
# War room (Goals)
Room 2 0 room 64 208 48 16 $dim
Put dungeon 80 160 32 64 480 0; Put dungeon 80 160 32 64 592 0
Put int16 13 161 38 37 533 66 $dim; Put int16 160 1068 32 16 536 74 $dim; Put int16 146 497 13 21 516 76 $dim; Put int16 162 497 13 21 574 76 $dim
# Researcher workshop (floor shifted teal -> slate like the command room: an unlit room must not look cyan)
Room 0 1 dungeon 64 0 48 48 $slate
Put workbench 112 115 80 61 40 208; Put anvil 80 36 79 56 92 264; Put furniture 736 165 32 27 4 276
# Command room (runtime core)
Room 1 1 dungeon 64 0 48 48 $slate
Put dungeon 112 0 48 48 296 240 $slate   # the pit tile is teal too; unshifted it reads as a block of "active" light under the core
Put apt 17 224 30 16 224 168 $dim; Put apt 17 224 30 16 305 168 $dim; Put apt 17 224 30 16 386 168 $dim
Put apt 16 129 32 31 216 208 $dim; Put apt 16 129 32 31 392 208 $dim
Put apt 16 182 32 24 216 244 $dim; Put apt 16 182 32 24 392 244 $dim
Put apt 86 179 20 28 204 292 $dim; Put apt 86 179 20 28 416 292 $dim
Put anvil 96 132 48 28 296 294
# Publisher workshop (stone floor dimmed so it isn't the brightest floor when unlit)
Room 2 1 floors 256 16 48 48 $stoneDim
Put anvil 176 14 96 82 504 204; Put workbench 48 115 48 45 468 276
# Engine room (Workflows)
Room 0 2 dungeon 112 160 32 32
Put furnace 112 68 77 124 4 356 $embers; Put workbench 103 64 73 48 96 422
# Entrance hall
Room 1 2 floors 256 16 48 48
Put furniture 83 432 58 32 230 432; Put furniture 83 432 58 32 352 432
Put dungeon 80 96 32 32 240 360; Put dungeon 80 96 32 32 368 360; Put dungeon 64 112 16 48 304 408; Put dungeon 64 112 16 48 328 408
# Vault (Artifacts)
Room 2 2 room 64 208 48 16 $dim
Put int16 114 772 27 39 470 396 $dim; Put int16 114 820 27 39 500 396 $dim; Put int16 114 772 27 39 530 396 $dim; Put int16 114 820 27 39 560 396 $dim; Put furniture 736 165 32 27 600 404
# No chests are baked into the vault: on the Artifacts screen each chest is ONE real artifact (a live layer).
# Baked chests would read as artifacts that don't exist.
# hall candles
# note: PowerShell variables are case-insensitive, so this loop must not be named $p (it would clobber $P)
foreach ($cand in @(@(180, 56), @(444, 56), @(180, 392), @(444, 392))) { Put dungeon 64 112 16 48 $cand[0] $cand[1] }

$g.Dispose()
$canvas.Save("$here\keep-v4-1x.png", [System.Drawing.Imaging.ImageFormat]::Png)
$big = New-Object System.Drawing.Bitmap ($W * 2), ($H * 2); $gg = [System.Drawing.Graphics]::FromImage($big); $gg.InterpolationMode = 'NearestNeighbor'; $gg.PixelOffsetMode = 'Half'
$gg.DrawImage($canvas, 0, 0, $W * 2, $H * 2); $gg.Dispose(); $big.Save("$here\keep-v4-2x.png", [System.Drawing.Imaging.ImageFormat]::Png)
$labels = @("Events", "Approvals", "Goals", "Researcher", "Runtime", "Publisher", "Workflows", "Entrance", "Artifacts")
$rooms = [ordered]@{}
for ($i = 0; $i -lt 9; $i++) { $c = $i % 3; $r = [Math]::Floor($i / 3)
  $rooms[$labels[$i]] = [ordered]@{ x = ([int]$cx[$c] + $PX) * 2; y = ([int]$ry[$r] + $P) * 2; w = [int]$cw[$c] * 2; h = [int]$rh[$r] * 2; wall = 96 } }
$rooms | ConvertTo-Json | Set-Content -Encoding utf8 "$here\keep-v4-rooms.json"
$big.Dispose(); $canvas.Dispose(); foreach ($b in $bmp.Values) { $b.Dispose() }
"keep v4 composed"
