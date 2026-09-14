# Pixel-honest light pools (cycle 2 rewrite).
# Radial falloff quantised to 4 alpha levels with an ordered Bayer 4x4 dither, one logical
# pixel = a 2x2 block (so the dither matches the 2x world grid). Written directly, no resampling.
# Colours carry meaning: active cyan and wait amber are STATE; core silver is the runtime;
# ambient is a dim neutral warm grey that must never read as amber state; torch is a tiny warm point.
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bayer = @(0,8,2,10, 12,4,14,6, 3,11,1,9, 15,7,13,5)
$pools = @(
  @{ name = "light-active";  rgb = @(8,184,249);   w = 176; h = 128; max = 0.55 },
  @{ name = "light-wait";    rgb = @(248,166,15);  w = 176; h = 128; max = 0.55 },
  @{ name = "light-core";    rgb = @(221,232,255); w = 176; h = 128; max = 0.6 },
  @{ name = "light-ambient"; rgb = @(184,168,144); w = 176; h = 128; max = 0.22 },
  @{ name = "light-torch";   rgb = @(252,210,11);  w = 32;  h = 24;  max = 0.45 }
)
foreach ($p in $pools) {
  $bmp = New-Object System.Drawing.Bitmap ($p.w * 2), ($p.h * 2), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $cx = ($p.w - 1) / 2.0; $cy = ($p.h - 1) / 2.0
  for ($y = 0; $y -lt $p.h; $y++) { for ($x = 0; $x -lt $p.w; $x++) {
    $dx = ($x - $cx) / $cx; $dy = ($y - $cy) / $cy
    $d = [Math]::Sqrt($dx * $dx + $dy * $dy)
    $v = 1.0 - $d; if ($v -lt 0) { $v = 0.0 }
    $v = $v * $v * (3.0 - 2.0 * $v)
    $t = ($bayer[($y % 4) * 4 + ($x % 4)] + 0.5) / 16.0
    $level = [Math]::Floor($v * 4.0 + $t - 0.5)
    if ($level -lt 0) { $level = 0 }; if ($level -gt 4) { $level = 4 }
    $a = [int][Math]::Round(($level / 4.0) * $p.max * 255)
    $c = [System.Drawing.Color]::FromArgb($a, $p.rgb[0], $p.rgb[1], $p.rgb[2])
    $bmp.SetPixel(2 * $x, 2 * $y, $c); $bmp.SetPixel(2 * $x + 1, 2 * $y, $c); $bmp.SetPixel(2 * $x, 2 * $y + 1, $c); $bmp.SetPixel(2 * $x + 1, 2 * $y + 1, $c)
  } }
  $bmp.Save("$here\$($p.name)-2x.png", [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
"light pools written"
