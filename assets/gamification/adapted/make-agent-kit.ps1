# make-agent-kit.ps1 — the layered agent character kit (R2; v2 2026-09-16: walk, work and three facings).
#
# Reads the Pixel Crawler base body (Entities/Characters/Body_A: Idle, Walk and Collect, facing Down, Side
# and Up) READ-ONLY and writes one transparent strip per pose, facing and layer option into ./agent-kit-2x/,
# named {pose}-{facing}-{part}-{option}.png. Side faces right; the renderer mirrors it for left. Nothing under
# Tile Pack is written. Options, colours, poses and frame counts come from src/definitions/appearanceCatalogue.json,
# the same file the API validates against and the Agent Builder offers, so art and data cannot drift apart.
#
# Each layer is painted frame by frame against THAT frame's own anatomy (Body_A's neck is 13 rows below the top
# of its head, though the figure breathes, sways, crouches and raises its arms), so layers stay locked to the
# body. Facing changes what is visible: from behind (up) hair covers the whole head and there are no glasses or
# chest mark; from the side (facing right) there is one eye, and long hair, buns and tails hang at the back.
# Layers stack in this order: body, bottom, top, hair, accessory, mark.
#
# Frames are cropped to 34x34 around the figure and scaled 2x nearest-neighbour: 68x68 per frame.
#
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File assets/gamification/adapted/make-agent-kit.ps1

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Resolve-Path (Join-Path $here "..\..\..")
$catalogue = Get-Content -Raw (Join-Path $repo "src\definitions\appearanceCatalogue.json") | ConvertFrom-Json
$base = Join-Path $repo "assets\gamification\Tile Pack\Pixel Crawler - Free Pack\Entities\Characters\Body_A\Animations"
$out = Join-Path $here "agent-kit-2x"
if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force -Path $out | Out-Null

$CELL = 64; $CROP = 34; $CROP_X = 15; $CROP_Y = 14
$sheetDir = @{ idle = "Idle_Base\Idle"; walk = "Walk_Base\Walk"; work = "Collect_Base\Collect" }
$facingName = @{ down = "Down"; side = "Side"; up = "Up" }

function Argb([string]$hex) { return [System.Drawing.ColorTranslator]::FromHtml($hex).ToArgb() }
$OUTLINE = (Argb "#000000"); $SKIN_LIGHT = (Argb "#D9A066"); $SKIN_SHADE = (Argb "#A26543"); $SKIN_HI = (Argb "#FAC895"); $EYE_WHITE = (Argb "#FFFCFC")
$INK = Argb "#3B2A1A"; $WOOD = Argb "#1C130D"; $CREAM = Argb "#F3E3C3"; $CREAM_SHADE = Argb "#B39E74"
$TEAL = Argb "#2BD9C5"; $TEAL_DARK = Argb "#1C9C8D"; $LEATHER = Argb "#8A6A4A"; $LEATHER_DARK = Argb "#5E4630"

function Is-Skin([int]$v) { return ($v -eq $SKIN_LIGHT -or $v -eq $SKIN_SHADE -or $v -eq $SKIN_HI) }

# ---- Read frames and their anatomy ----------------------------------------------------------
function Read-Frames([string]$pose, [string]$facing) {
  $bmp = [System.Drawing.Bitmap]::FromFile((Join-Path $base ("{0}_{1}-Sheet.png" -f $sheetDir[$pose], $facingName[$facing])))
  $n = [int]$catalogue.frames.$pose
  $frames = @()
  for ($f = 0; $f -lt $n; $f++) {
    $px = New-Object 'int[,]' $CELL, $CELL
    $minY = $CELL; $maxY = -1
    for ($y = 0; $y -lt $CELL; $y++) { for ($x = 0; $x -lt $CELL; $x++) {
      $c = $bmp.GetPixel($x + $CELL * $f, $y)
      if ($c.A -gt 0) { $px[$x, $y] = $c.ToArgb(); if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y } }
    } }
    # The head's top row: skip rows that are only raised hands (two or more separate runs, each narrow).
    $headTop = $minY
    for ($y = $minY; $y -lt $minY + 8; $y++) {
      $runs = 0; $longest = 0; $len = 0
      for ($x = 0; $x -lt $CELL; $x++) { if ($px[$x, $y] -ne 0) { $len++; if ($len -eq 1) { $runs++ }; if ($len -gt $longest) { $longest = $len } } else { $len = 0 } }
      if ($runs -eq 1 -or $longest -ge 5) { $headTop = $y; break }
    }
    $neck = $headTop + 13; $bodyTop = $neck + 1
    $hMin = $CELL; $hMax = -1; $bMin = $CELL; $bMax = -1; $eyeRow = -1; $eyes = @()
    for ($y = $headTop; $y -le $maxY; $y++) { for ($x = 0; $x -lt $CELL; $x++) {
      if ($px[$x, $y] -eq 0) { continue }
      if ($y -lt $neck) {
        if ($x -lt $hMin) { $hMin = $x }; if ($x -gt $hMax) { $hMax = $x }
        if ($px[$x, $y] -eq $EYE_WHITE) { if ($eyeRow -lt 0) { $eyeRow = $y }; if ($y -eq $eyeRow) { $eyes += $x } }
      }
      elseif ($y -ge $bodyTop) { if ($x -lt $bMin) { $bMin = $x }; if ($x -gt $bMax) { $bMax = $x } }
    } }
    $frames += [pscustomobject]@{ px = $px; headTop = $headTop; neck = $neck; bodyTop = $bodyTop; maxY = $maxY; hMin = $hMin; hMax = $hMax; bMin = $bMin; bMax = $bMax; eyeRow = $eyeRow; eyes = $eyes; cx = [int][math]::Floor(($hMin + $hMax) / 2) }
  }
  $bmp.Dispose()
  return ,$frames
}

# ---- Write a layer strip ------------------------------------------------------------------------
function Save-Strip($layers, [string]$name) {
  $n = $layers.Count
  $small = New-Object System.Drawing.Bitmap ($CROP * $n), $CROP, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($f = 0; $f -lt $n; $f++) {
    $l = $layers[$f]
    for ($y = $CROP_Y; $y -lt $CROP_Y + $CROP; $y++) { for ($x = $CROP_X; $x -lt $CROP_X + $CROP; $x++) {
      # Read into a variable first: inside a method call's arguments PowerShell would split `[$x, $y]` at the comma.
      $argb = $l[$x, $y]
      if ($argb -ne 0) { $small.SetPixel($f * $CROP + ($x - $CROP_X), $y - $CROP_Y, [System.Drawing.Color]::FromArgb($argb)) }
    } }
  }
  $big = New-Object System.Drawing.Bitmap ($CROP * $n * 2), ($CROP * 2), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
  $g.DrawImage($small, 0, 0, $big.Width, $big.Height)
  $g.Dispose(); $small.Dispose()
  $big.Save((Join-Path $out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $big.Dispose()
}

# The leading comma stops PowerShell unrolling the 2-D array on return.
# NB: PowerShell variables are case-insensitive, so layer and palette variables must differ by more than case.
function New-Layer { return ,(New-Object 'int[,]' $CELL, $CELL) }
function Put($l, [int]$x, [int]$y, [int]$v) { if ($x -ge 0 -and $x -lt $CELL -and $y -ge 0 -and $y -lt $CELL) { $l[$x, $y] = $v } }

# A two-shade recolour of skin pixels: skin light/highlight -> light, skin shade -> dark.
function Shade([int]$v, [int]$light, [int]$dark) { if ($v -eq $SKIN_SHADE) { return $dark } else { return $light } }

$fileCount = 0
foreach ($pose in $catalogue.poses) { foreach ($facing in $catalogue.facings) {
  $frames = Read-Frames $pose $facing
  $key = "$pose-$facing"
  $back = ($facing -eq "up"); $side = ($facing -eq "side")

  # body-{skin}
  foreach ($skin in $catalogue.parts.skin.options) {
    $pal = $catalogue.palettes.skin.$skin; $lite = Argb $pal[0]; $dark = Argb $pal[1]; $highlight = Argb $pal[2]
    $layers = foreach ($fr in $frames) {
      $l = New-Layer
      for ($y = 0; $y -lt $CELL; $y++) { for ($x = 0; $x -lt $CELL; $x++) {
        $v = $fr.px[$x, $y]; if ($v -eq 0) { continue }
        if ($v -eq $SKIN_LIGHT) { $l[$x, $y] = $lite } elseif ($v -eq $SKIN_SHADE) { $l[$x, $y] = $dark } elseif ($v -eq $SKIN_HI) { $l[$x, $y] = $highlight } else { $l[$x, $y] = $v }
      } }
      ,$l
    }
    Save-Strip $layers "$key-body-$skin.png"; $fileCount++
  }

  # hair-{style}-{colour}
  foreach ($style in $catalogue.parts.hair.options) {
    if ($style -eq "none") { continue }
    foreach ($colour in $catalogue.parts.hairColor.options) {
      $pal = $catalogue.palettes.hair.$colour; $lite = Argb $pal[0]; $dark = Argb $pal[1]
      $layers = foreach ($fr in $frames) {
        $l = New-Layer; $t = $fr.headTop
        for ($y = $t + 1; $y -lt $fr.neck; $y++) { for ($x = $fr.hMin; $x -le $fr.hMax; $x++) {
          $v = $fr.px[$x, $y]; if (-not (Is-Skin $v)) { continue }
          $crown = $y -le $t + 4
          $backCol = if ($side) { $x -le $fr.hMin + 3 } else { $false }
          $side2 = ($x -le $fr.hMin + 2 -or $x -ge $fr.hMax - 2)
          $side3 = ($x -le $fr.hMin + 3 -or $x -ge $fr.hMax - 3)
          $paint = if ($back) {
            # From behind, hair covers the head; a hood also covers it; short hair leaves the nape.
            switch ($style) { "short" { $y -le $t + 9 } "curly" { $y -le $t + 9 } default { $true } }
          } elseif ($side) {
            switch ($style) { "short" { $crown -or ($backCol -and $y -le $t + 7) } "bun" { $crown -or ($backCol -and $y -le $t + 7) } "ponytail" { $crown -or ($backCol -and $y -le $t + 7) } "curly" { $crown -or ($backCol -and $y -le $t + 8) } "long" { $crown -or $backCol } "hood" { ($y -le $t + 5) -or $x -le $fr.hMin + 5 } }
          } else {
            switch ($style) { "short" { $crown } "bun" { $crown } "ponytail" { $crown } "curly" { $crown -or (($y -eq $t + 5) -and $side2) } "long" { $crown -or $side2 } "hood" { ($y -le $t + 5) -or $side3 } }
          }
          if ($paint) { $l[$x, $y] = Shade $v $lite $dark }
        } }
        # Crown shapes above and behind the head.
        $c = $fr.cx
        if ($style -eq "bun") {
          $bx = if ($side) { $fr.hMin + 1 } else { $c }
          for ($x = $bx - 1; $x -le $bx + 2; $x++) { Put $l $x ($t - 3) $OUTLINE }
          foreach ($y in ($t - 2), ($t - 1)) { Put $l ($bx - 2) $y $OUTLINE; Put $l ($bx + 3) $y $OUTLINE; for ($x = $bx - 1; $x -le $bx + 2; $x++) { Put $l $x $y $lite } }
          Put $l ($bx + 2) ($t - 1) $dark
        }
        if ($style -eq "curly") {
          for ($x = $fr.hMin + 1; $x -lt $fr.hMax; $x += 2) { Put $l $x ($t - 1) $OUTLINE; Put $l $x $t $lite }
        }
        if ($style -eq "ponytail" -and -not ($facing -eq "down")) {
          # The tail hangs behind: at the back of the head from the side, down the middle from behind.
          $tx = if ($side) { $fr.hMin - 1 } else { $c }
          for ($y = $t + 4; $y -le $t + 12; $y++) {
            if ($side) { Put $l ($tx - 1) $y $OUTLINE; Put $l $tx $y $(if ($y % 2) { $lite } else { $dark }); Put $l ($tx + 1) $y $OUTLINE }
            else { Put $l ($tx - 1) $y $OUTLINE; Put $l $tx $y $lite; Put $l ($tx + 1) $y $dark; Put $l ($tx + 2) $y $OUTLINE }
          }
          if ($side) { Put $l $tx ($t + 13) $OUTLINE } else { Put $l $tx ($t + 13) $OUTLINE; Put $l ($tx + 1) ($t + 13) $OUTLINE }
        }
        if ($style -eq "long" -and $back) {
          for ($y = $fr.bodyTop; $y -le $fr.bodyTop + 2; $y++) { for ($x = $fr.bMin + 3; $x -le $fr.bMax - 3; $x++) { if ($fr.px[$x, $y] -ne 0 -and $fr.px[$x, $y] -ne $OUTLINE) { $l[$x, $y] = $dark } } }
        }
        ,$l
      }
      Save-Strip $layers "$key-hair-$style-$colour.png"; $fileCount++
    }
  }

  # top-{style}-{colour}: the torso, 9 rows below the neck; hands stay bare except under a cloak.
  foreach ($style in $catalogue.parts.top.options) {
    foreach ($colour in $catalogue.parts.topColor.options) {
      $pal = $catalogue.palettes.cloth.$colour; $lite = Argb $pal[0]; $dark = Argb $pal[1]
      $layers = foreach ($fr in $frames) {
        $l = New-Layer; $b = $fr.bodyTop
        $front = if ($side) { $fr.bMax - 3 } else { -1 }
        for ($y = $b; $y -le $b + 8; $y++) { for ($x = $fr.bMin; $x -le $fr.bMax; $x++) {
          $v = $fr.px[$x, $y]; if (-not (Is-Skin $v)) { continue }
          $hand = ($y -ge $b + 5) -and ($x -le $fr.bMin + 3 -or $x -ge $fr.bMax - 3)
          $inner = ($x -ge $fr.bMin + 4 -and $x -le $fr.bMax - 4)
          if ($style -eq "vest") { if ($inner -or ($side -and $x -le $fr.bMax - 2)) { $l[$x, $y] = Shade $v $lite $dark }; continue }
          if ($hand -and $style -ne "cloak") { continue }
          $l[$x, $y] = Shade $v $lite $dark
          switch ($style) {
            "tunic" { if ($y -eq $b + 7 -and $inner) { $l[$x, $y] = $INK } }
            "robe" { if ($y -eq $b + 1 -and $inner) { $l[$x, $y] = $dark } }
            "coat" {
              if (-not $back -and $y -ge $b + 1) {
                $stripe = if ($side) { $x -eq $front } else { $x -eq $fr.cx -or $x -eq $fr.cx + 1 }
                if ($stripe) { $l[$x, $y] = Shade $v $CREAM $CREAM_SHADE }
              }
            }
            "tabard" {
              $panel = if ($side) { $x -ge $front } else { $x -ge $fr.cx - 1 -and $x -le $fr.cx + 2 }
              if ($panel -and -not $back) { $l[$x, $y] = $dark }
              if ($y -eq $b + 6) { $l[$x, $y] = $INK }
            }
            "apron" {
              $bib = if ($side) { $x -ge $front } else { $inner }
              if (-not $back -and $y -ge $b + 3 -and $bib) { $l[$x, $y] = Shade $v $CREAM $CREAM_SHADE }
              if ($back -and $y -eq $b + 4 -and $inner) { $l[$x, $y] = $CREAM_SHADE }
            }
            "cloak" { if ($y -le $b + 1) { $l[$x, $y] = $dark } }
          }
        } }
        ,$l
      }
      Save-Strip $layers "$key-top-$style-$colour.png"; $fileCount++
    }
  }

  # bottom-{style}-{colour}: legs below the torso, with boots on the last rows.
  foreach ($style in $catalogue.parts.bottom.options) {
    foreach ($colour in $catalogue.parts.bottomColor.options) {
      $pal = $catalogue.palettes.cloth.$colour; $lite = Argb $pal[0]; $dark = Argb $pal[1]
      $layers = foreach ($fr in $frames) {
        $l = New-Layer; $b = $fr.bodyTop; $legTop = $b + 9
        for ($y = $legTop; $y -le $fr.maxY; $y++) {
          $bootRows = if ($style -eq "boots") { 4 } else { 2 }
          $boots = $y -ge $fr.maxY - ($bootRows - 1)
          $clothed = switch ($style) { "trousers" { -not $boots } "boots" { -not $boots } "shorts" { $y -le $legTop + 1 } "skirt" { $y -le $legTop + 2 } "long-skirt" { $y -le $fr.maxY - 2 } }
          for ($x = $fr.bMin; $x -le $fr.bMax; $x++) {
            $v = $fr.px[$x, $y]; if (-not (Is-Skin $v)) { continue }
            if ($boots) { $l[$x, $y] = Shade $v $INK $WOOD } elseif ($clothed) { $l[$x, $y] = Shade $v $lite $dark }
          }
          $skirtRow = ($style -eq "skirt" -and $y -le $legTop + 2) -or ($style -eq "long-skirt" -and $y -le $fr.maxY - 2)
          if ($skirtRow) {
            # A skirt closes the gap between the legs: span the leg columns, outlined at both ends.
            $lo = $fr.bMin + 2; $hi = $fr.bMax - 2; $first = -1; $last = -1
            for ($x = $lo; $x -le $hi; $x++) { if ($fr.px[$x, $y] -ne 0) { if ($first -lt 0) { $first = $x }; $last = $x } }
            if ($first -ge 0 -and $last -gt $first) {
              for ($x = $first + 1; $x -lt $last; $x++) { $l[$x, $y] = $lite }
              $l[$first, $y] = $OUTLINE; $l[$last, $y] = $OUTLINE
              $hem = if ($style -eq "skirt") { $legTop + 2 } else { $fr.maxY - 2 }
              if ($y -eq $hem) { for ($x = $first + 1; $x -lt $last; $x++) { $l[$x, $y] = $dark } }
            }
          }
        }
        ,$l
      }
      Save-Strip $layers "$key-bottom-$style-$colour.png"; $fileCount++
    }
  }

  # accessory-{name}: fixed colours.
  foreach ($acc in $catalogue.parts.accessory.options) {
    if ($acc -eq "none") { continue }
    $layers = foreach ($fr in $frames) {
      $l = New-Layer; $t = $fr.headTop; $b = $fr.bodyTop
      switch ($acc) {
        "glasses" {
          # Lenses over the eyes that are visible: two from the front, one from the side, none from behind.
          $y = $fr.eyeRow
          if (-not $back -and $y -ge 0 -and $fr.eyes.Count -ge 1) {
            $lo = ($fr.eyes | Measure-Object -Minimum).Minimum - 1; $hi = ($fr.eyes | Measure-Object -Maximum).Maximum + 1
            if ($side) { $hi = [math]::Min($hi + 1, $fr.hMax) }
            foreach ($yy in ($y - 1), $y) { for ($x = $lo; $x -le $hi; $x++) {
              $v = $fr.px[$x, $yy]
              if (Is-Skin $v) { $l[$x, $yy] = $INK } elseif ($v -ne 0 -and $v -ne $OUTLINE) { $l[$x, $yy] = Argb "#BFE6FF" }
            } }
          }
        }
        "scarf" {
          for ($y = $b; $y -le $b + 1; $y++) { for ($x = $fr.bMin + 2; $x -le $fr.bMax - 2; $x++) {
            $v = $fr.px[$x, $y]; if ($v -ne 0 -and $v -ne $OUTLINE) { $l[$x, $y] = if ($y -eq $b) { $CREAM } else { $CREAM_SHADE } }
          } }
          if ($side) { Put $l ($fr.bMin + 1) ($b + 2) $CREAM_SHADE; Put $l ($fr.bMin + 1) ($b + 3) $CREAM_SHADE }
        }
        "cap" {
          for ($y = $t + 1; $y -le $t + 3; $y++) { for ($x = $fr.hMin + 1; $x -lt $fr.hMax; $x++) {
            $v = $fr.px[$x, $y]; if ($v -ne 0 -and $v -ne $OUTLINE) { $l[$x, $y] = if ($y -eq $t + 1) { $LEATHER } else { $LEATHER_DARK } }
          } }
          $y = $t + 4
          $lo = $fr.hMin; $hi = $fr.hMax
          if ($side) { $hi = $fr.hMax + 2 }
          for ($x = $lo; $x -le $hi; $x++) { Put $l $x $y $INK }
          Put $l ($lo - 1) $y $OUTLINE; Put $l ($hi + 1) $y $OUTLINE
        }
        "headband" {
          $y = $t + 3
          for ($x = $fr.hMin; $x -le $fr.hMax; $x++) { $v = $fr.px[$x, $y]; if ($v -ne 0 -and $v -ne $OUTLINE) { $l[$x, $y] = $TEAL } }
          if ($back) { Put $l ($fr.cx) ($t + 4) $TEAL_DARK; Put $l ($fr.cx + 1) ($t + 5) $TEAL_DARK }
        }
        "satchel" {
          # A strap across the body and a bag at the hip (behind the figure from the side).
          for ($i = 0; $i -le 6; $i++) {
            $sx = if ($back) { $fr.bMax - 3 - $i } else { $fr.bMin + 3 + $i }
            $sy = $b + $i
            if ($fr.px[$sx, $sy] -ne 0 -and $fr.px[$sx, $sy] -ne $OUTLINE -and -not $side) { $l[$sx, $sy] = $LEATHER_DARK }
          }
          $bagX = if ($side) { $fr.bMin - 2 } elseif ($back) { $fr.bMin - 1 } else { $fr.bMax - 1 }
          for ($y = $b + 6; $y -le $b + 9; $y++) { for ($x = $bagX; $x -le $bagX + 3; $x++) {
            $edge = ($y -eq $b + 6 -or $y -eq $b + 9 -or $x -eq $bagX -or $x -eq $bagX + 3)
            Put $l $x $y $(if ($edge) { $OUTLINE } elseif ($y -eq $b + 7) { $LEATHER_DARK } else { $LEATHER })
          } }
        }
      }
      ,$l
    }
    Save-Strip $layers "$key-accessory-$acc.png"; $fileCount++
  }

  # mark-{name}: a 3x3 role glyph on the chest (the front of it from the side; hidden from behind). Decoration only.
  $glyphs = @{
    book = @("222", "211", "222"); quill = @("001", "010", "200"); lens = @("222", "212", "222")
    scroll = @("111", "121", "111"); gear = @("020", "212", "020")
    key = @("210", "200", "220"); flask = @("020", "212", "222"); compass = @("020", "212", "020")
  }
  $glyphColours = @{
    book = @($CREAM, $INK); quill = @($CREAM, $INK); lens = @((Argb "#BFE6FF"), (Argb "#6E7B8C"))
    scroll = @($CREAM, $CREAM_SHADE); gear = @((Argb "#E6E1D6"), (Argb "#6E6C69"))
    key = @((Argb "#E6D08A"), (Argb "#9E834A")); flask = @((Argb "#BFE6FF"), (Argb "#6E7B8C")); compass = @((Argb "#E6D08A"), $INK)
  }
  foreach ($mark in $catalogue.parts.mark.options) {
    if ($mark -eq "none") { continue }
    $layers = foreach ($fr in $frames) {
      $l = New-Layer
      if (-not $back) {
        $ox = if ($side) { $fr.bMax - 4 } else { $fr.bMin + 4 }; $oy = $fr.bodyTop + 2
        for ($r = 0; $r -lt 3; $r++) { for ($c = 0; $c -lt 3; $c++) {
          $k = [string]$glyphs[$mark][$r][$c]
          if ($k -ne "0" -and $fr.px[($ox + $c), ($oy + $r)] -ne 0) { $l[($ox + $c), ($oy + $r)] = $glyphColours[$mark][[int]$k - 1] }
        } }
      }
      ,$l
    }
    Save-Strip $layers "$key-mark-$mark.png"; $fileCount++
  }
} }

"Wrote $fileCount layer strips into $out"
