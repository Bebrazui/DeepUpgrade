# DeepUpgrade icon generator v2: smaller whale (matches official DeepSeek app proportions)
Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\DeepUpgrade\android\.icon_work\icon_512.png'
$resDir  = 'C:\DeepUpgrade\android\app\src\main\res'
$workDir = 'C:\DeepUpgrade\android\.icon_work'

$src = [System.Drawing.Bitmap]::FromFile($srcPath)
$W = $src.Width

# --- measure whale (non-white) bounding box ---
$minx = $W; $miny = $W; $maxx = 0; $maxy = 0
for ($y = 0; $y -lt $W; $y++) {
    for ($x = 0; $x -lt $W; $x++) {
        $p = $src.GetPixel($x, $y)
        if (-not ($p.R -gt 240 -and $p.G -gt 240 -and $p.B -gt 240)) {
            if ($x -lt $minx) { $minx = $x }; if ($x -gt $maxx) { $maxx = $x }
            if ($y -lt $miny) { $miny = $y }; if ($y -gt $maxy) { $maxy = $y }
        }
    }
}
$whaleW = $maxx - $minx + 1
$whaleH = $maxy - $miny + 1
Write-Host "whale bbox: X $minx-$maxx Y $miny-$maxy (w=$whaleW h=$whaleH)"
$cx = $minx + $whaleW / 2.0
$cy = $miny + $whaleH / 2.0

function NewGfx($bmp) {
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    return $g
}

# draw whale centered at $targetW width on a white $canvas x $canvas bitmap
function New-Composed($canvas, $targetW) {
    $bmp = New-Object System.Drawing.Bitmap($canvas, $canvas)
    $g = NewGfx $bmp
    $g.Clear([System.Drawing.Color]::White)
    $s = $targetW / $whaleW
    $dw = $W * $s; $dh = $W * $s
    $dx = $canvas / 2.0 - $cx * $s
    $dy = $canvas / 2.0 - $cy * $s
    $g.DrawImage($src, [float]$dx, [float]$dy, [float]$dw, [float]$dh)
    $g.Dispose()
    return $bmp
}

# master for legacy icons: whale at 52% of canvas width
$master = New-Composed 1024 ($1024 * 0.52)
$master.Save((Join-Path $workDir 'master_legacy.png'), [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "legacy master: whale w = $([int](1024*0.52))px of 1024"

function Save-Launcher($size, $dst) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = NewGfx $bmp
    $g.DrawImage($master, 0, 0, $size, $size)
    $g.Dispose(); $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Host "wrote $dst"
}

function Save-Round($size, $dst) {
    $big = $size * 4
    $bmp = New-Object System.Drawing.Bitmap($big, $big)
    $g = NewGfx $bmp
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddEllipse(0, 0, $big, $big)
    $g.SetClip($path)
    $g.DrawImage($master, 0, 0, $big, $big)
    $g.Dispose()
    $out = New-Object System.Drawing.Bitmap($size, $size)
    $g2 = NewGfx $out
    $g2.DrawImage($bmp, 0, 0, $size, $size)
    $g2.Dispose(); $bmp.Dispose()
    $out.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $out.Dispose()
    Write-Host "wrote $dst"
}

# adaptive foreground: whale at 40dp of the 108dp canvas (~55% of the visible safe zone)
function Save-Foreground($size, $dst) {
    $bmp = New-Composed $size ($size * 40.0 / 108.0)
    $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
    Write-Host "wrote $dst"
}

$densities = @{
    'mdpi'    = 1.0
    'hdpi'    = 1.5
    'xhdpi'   = 2.0
    'xxhdpi'  = 3.0
    'xxxhdpi' = 4.0
}

foreach ($d in $densities.GetEnumerator()) {
    $dir = Join-Path $resDir ("mipmap-" + $d.Key)
    $launcher = [int](48 * $d.Value)
    $fg       = [int](108 * $d.Value)
    Save-Launcher   $launcher (Join-Path $dir 'ic_launcher.png')
    Save-Round      $launcher (Join-Path $dir 'ic_launcher_round.png')
    Save-Foreground $fg       (Join-Path $dir 'ic_launcher_foreground.png')
}

$master.Dispose()
$src.Dispose()
Write-Host 'DONE'
