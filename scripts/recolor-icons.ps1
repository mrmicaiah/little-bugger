param(
  [string]$iconDir = "C:\Users\mrmic\Projects\little-bugger\extension\icons",
  [double]$hueShiftDeg = 125.0
)

Add-Type -AssemblyName System.Drawing

function Get-HSV([int]$r, [int]$g, [int]$b) {
  $rf = $r / 255.0; $gf = $g / 255.0; $bf = $b / 255.0
  $max = [Math]::Max($rf, [Math]::Max($gf, $bf))
  $min = [Math]::Min($rf, [Math]::Min($gf, $bf))
  $delta = $max - $min
  $h = 0.0
  if ($delta -gt 0) {
    if ($max -eq $rf)      { $h = 60 * ((($gf - $bf) / $delta) % 6) }
    elseif ($max -eq $gf)  { $h = 60 * ((($bf - $rf) / $delta) + 2) }
    else                   { $h = 60 * ((($rf - $gf) / $delta) + 4) }
  }
  if ($h -lt 0) { $h += 360 }
  $s = if ($max -gt 0) { $delta / $max } else { 0.0 }
  $v = $max
  return @($h, $s, $v)
}

function Get-RGB([double]$h, [double]$s, [double]$v) {
  $h = $h % 360
  if ($h -lt 0) { $h += 360 }
  $c = $v * $s
  $x = $c * (1 - [Math]::Abs((($h / 60) % 2) - 1))
  $m = $v - $c
  $rp = 0.0; $gp = 0.0; $bp = 0.0
  if     ($h -lt 60)  { $rp=$c; $gp=$x; $bp=0 }
  elseif ($h -lt 120) { $rp=$x; $gp=$c; $bp=0 }
  elseif ($h -lt 180) { $rp=0;  $gp=$c; $bp=$x }
  elseif ($h -lt 240) { $rp=0;  $gp=$x; $bp=$c }
  elseif ($h -lt 300) { $rp=$x; $gp=0;  $bp=$c }
  else                { $rp=$c; $gp=0;  $bp=$x }
  $r = [int][Math]::Round(($rp + $m) * 255)
  $g = [int][Math]::Round(($gp + $m) * 255)
  $b = [int][Math]::Round(($bp + $m) * 255)
  if ($r -lt 0) { $r = 0 } elseif ($r -gt 255) { $r = 255 }
  if ($g -lt 0) { $g = 0 } elseif ($g -gt 255) { $g = 255 }
  if ($b -lt 0) { $b = 0 } elseif ($b -gt 255) { $b = 255 }
  return @($r, $g, $b)
}

foreach ($size in 16, 32, 48, 128) {
  $src = Join-Path $iconDir "bug-green-$size.png"
  $dst = Join-Path $iconDir "bug-purple-$size.png"
  if (-not (Test-Path $src)) {
    Write-Error "missing source: $src"
    continue
  }
  $bmp = New-Object System.Drawing.Bitmap($src)
  $out = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      $c = $bmp.GetPixel($x, $y)
      if ($c.A -eq 0) {
        $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
        continue
      }
      $hsv = Get-HSV $c.R $c.G $c.B
      $h2 = $hsv[0] + $hueShiftDeg
      $rgb = Get-RGB $h2 $hsv[1] $hsv[2]
      $newColor = [System.Drawing.Color]::FromArgb([int]$c.A, [int]$rgb[0], [int]$rgb[1], [int]$rgb[2])
      $out.SetPixel($x, $y, $newColor)
    }
  }
  $out.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "wrote $dst ($($out.Width)x$($out.Height))"
  $bmp.Dispose()
  $out.Dispose()
}
