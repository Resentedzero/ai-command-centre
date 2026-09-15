# Animation strips with a baked 1-logical-pixel dark outline, at 2x, for the motion prototype and later the UI.
# Same treatment as sprites-outlined-2x/ (single frames): the outline keeps sprites legible inside coloured state light.
# Each frame is padded by 1 logical pixel on every side, so outlines never bleed into the next frame.
# Sources are read-only. Output: strips-outlined-2x/<name>-strip-2x-outlined.png
Add-Type -AssemblyName System.Drawing
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$npc = Join-Path (Split-Path -Parent $here) "Tile Pack\Pixel Crawler - Free Pack\Entities\Npc's"
$outDir = Join-Path $here "strips-outlined-2x"
New-Item -ItemType Directory -Force $outDir | Out-Null
$outline = [System.Drawing.Color]::FromArgb(255, 11, 7, 5)   # pixel/outline #0B0705

# source, output name, frame width in source pixels
$jobs = @(
  @("Knight\Run\Run-Sheet.png", "knight-run", 64),
  @("Knight\Idle\Idle-Sheet.png", "knight-idle", 32),
  @("Knight\Death\Death-Sheet.png", "knight-death", 32),
  @("Wizzard\Run\Run-Sheet.png", "wizard-run", 64),
  @("Wizzard\Idle\Idle-Sheet.png", "wizard-idle", 32),
  @("Wizzard\Death\Death-Sheet.png", "wizard-death", 32)
)
foreach ($job in $jobs) {
  $src = [System.Drawing.Bitmap]::FromFile((Join-Path $npc $job[0]))
  $cw = $job[2]; $ch = $src.Height; $frames = [int]($src.Width / $cw)
  $ow = $cw + 2; $oh = $ch + 2
  $one = New-Object System.Drawing.Bitmap ($ow * $frames), $oh
  for ($f = 0; $f -lt $frames; $f++) {
    $opaque = New-Object 'bool[,]' $ow, $oh
    for ($y = 0; $y -lt $ch; $y++) { for ($x = 0; $x -lt $cw; $x++) {
      $p = $src.GetPixel($f * $cw + $x, $y)
      if ($p.A -gt 0) { $one.SetPixel($f * $ow + $x + 1, $y + 1, $p); $opaque[($x + 1), ($y + 1)] = $true } } }
    for ($y = 0; $y -lt $oh; $y++) { for ($x = 0; $x -lt $ow; $x++) {
      if ($opaque[$x, $y]) { continue }
      $near = $false
      for ($dy = -1; $dy -le 1 -and -not $near; $dy++) { for ($dx = -1; $dx -le 1; $dx++) {
        $nx = $x + $dx; $ny = $y + $dy
        if ($nx -ge 0 -and $ny -ge 0 -and $nx -lt $ow -and $ny -lt $oh -and $opaque[$nx, $ny]) { $near = $true; break } } }
      if ($near) { $one.SetPixel($f * $ow + $x, $y, $outline) } } }
  }
  $big = New-Object System.Drawing.Bitmap ($one.Width * 2), ($one.Height * 2)
  $g = [System.Drawing.Graphics]::FromImage($big); $g.InterpolationMode = 'NearestNeighbor'; $g.PixelOffsetMode = 'Half'
  $g.DrawImage($one, 0, 0, $big.Width, $big.Height); $g.Dispose()
  $big.Save((Join-Path $outDir ($job[1] + "-strip-2x-outlined.png")), [System.Drawing.Imaging.ImageFormat]::Png)
  "{0}: {1} frames, {2}x{3} px per frame at 2x" -f $job[1], $frames, ($ow * 2), ($oh * 2)
  $big.Dispose(); $one.Dispose(); $src.Dispose()
}
