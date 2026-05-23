using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class DxLightBorderSampler
{
    private const int Srccopy = 0x00CC0020;
    private const int ColorOnColor = 3;
    private const int Halftone = 4;

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("gdi32.dll")]
    private static extern bool StretchBlt(
        IntPtr hdcDest,
        int xDest,
        int yDest,
        int wDest,
        int hDest,
        IntPtr hdcSrc,
        int xSrc,
        int ySrc,
        int wSrc,
        int hSrc,
        int rop);

    [DllImport("gdi32.dll")]
    private static extern int SetStretchBltMode(IntPtr hdc, int mode);

    [DllImport("gdi32.dll")]
    private static extern uint GetPixel(IntPtr hdc, int x, int y);

    private static volatile bool exiting;

    public static int Main(string[] args)
    {
        Console.CancelKeyPress += delegate
        {
            exiting = true;
        };

        try
        {
            var options = SamplerOptions.FromArgs(args);
            using (var sampler = new BorderSampler(options))
            {
                Console.Error.WriteLine("DxLightBorderSampler backend=gdi-stretchblt display={0} grid={1}x{2} interval={3}ms",
                    options.DisplayId,
                    sampler.Cols,
                    sampler.Rows,
                    options.IntervalMs);
                Console.Out.WriteLine("{\"type\":\"ready\",\"backend\":\"gdi-stretchblt\",\"displayId\":\"" + Escape(options.DisplayId) + "\"}");
                Console.Out.Flush();

                var frames = 0;
                var stopwatch = new Stopwatch();
                while (!exiting && (options.FrameLimit <= 0 || frames < options.FrameLimit))
                {
                    stopwatch.Restart();
                    var frame = sampler.CaptureFrame();
                    stopwatch.Stop();
                    frames += 1;

                    Console.Out.WriteLine(frame.ToJson(options.DisplayId, options.Width, options.Height, sampler.Cols, sampler.Rows, stopwatch.Elapsed.TotalMilliseconds));
                    Console.Out.Flush();

                    if (options.FrameLimit > 0 && frames >= options.FrameLimit)
                    {
                        break;
                    }

                    var sleepMs = Math.Max(1, options.IntervalMs - (int)Math.Round(stopwatch.Elapsed.TotalMilliseconds));
                    Thread.Sleep(sleepMs);
                }
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.ToString());
            return 1;
        }
    }

    private static string Escape(string value)
    {
        return (value ?? string.Empty).Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private sealed class SamplerOptions
    {
        public string DisplayId = "DISPLAY1";
        public int X;
        public int Y;
        public int Width = 1;
        public int Height = 1;
        public int SamplingRate = 80;
        public int EdgeNumber = 3;
        public int EdgeThicknessPx;
        public int IntervalMs = 80;
        public int FrameLimit;
        public bool FastScale;
        public bool PointSample = true;

        public static SamplerOptions FromArgs(string[] args)
        {
            var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (var index = 0; index < args.Length; index += 1)
            {
                var key = args[index];
                if (!key.StartsWith("--", StringComparison.Ordinal))
                {
                    continue;
                }

                if (index + 1 < args.Length && !args[index + 1].StartsWith("--", StringComparison.Ordinal))
                {
                    values[key.Substring(2)] = args[index + 1];
                    index += 1;
                }
                else
                {
                    values[key.Substring(2)] = "true";
                }
            }

            var result = new SamplerOptions();
            result.DisplayId = Get(values, "displayId", result.DisplayId);
            result.X = GetInt(values, "x", result.X);
            result.Y = GetInt(values, "y", result.Y);
            result.Width = Math.Max(1, GetInt(values, "width", result.Width));
            result.Height = Math.Max(1, GetInt(values, "height", result.Height));
            result.SamplingRate = Clamp(GetInt(values, "samplingRate", result.SamplingRate), 20, 240);
            result.EdgeThicknessPx = Clamp(GetInt(values, "edgeThicknessPx", result.SamplingRate), 1, Math.Max(result.Width, result.Height));
            result.EdgeNumber = GetInt(values, "edgeNumber", result.EdgeNumber) == 4 ? 4 : 3;
            result.IntervalMs = Clamp(GetInt(values, "intervalMs", result.IntervalMs), 8, 1000);
            result.FrameLimit = Math.Max(0, GetInt(values, "frames", result.FrameLimit));
            result.FastScale = string.Equals(Get(values, "fastScale", "false"), "true", StringComparison.OrdinalIgnoreCase);
            result.PointSample = !string.Equals(Get(values, "pointSample", "true"), "false", StringComparison.OrdinalIgnoreCase);
            return result;
        }

        private static string Get(Dictionary<string, string> values, string key, string fallback)
        {
            string value;
            return values.TryGetValue(key, out value) ? value : fallback;
        }

        private static int GetInt(Dictionary<string, string> values, string key, int fallback)
        {
            string value;
            int parsed;
            return values.TryGetValue(key, out value) && int.TryParse(value, out parsed) ? parsed : fallback;
        }

        private static int Clamp(int value, int min, int max)
        {
            return Math.Min(max, Math.Max(min, value));
        }
    }

    private sealed class BorderSampler : IDisposable
    {
        private readonly SamplerOptions options;
        private readonly IntPtr screenDc;
        private readonly byte[] output;
        private readonly List<CaptureRegion> regions = new List<CaptureRegion>();
        private readonly List<SamplePoint> points = new List<SamplePoint>();

        public int Cols { get; private set; }
        public int Rows { get; private set; }

        public BorderSampler(SamplerOptions options)
        {
            this.options = options;
            screenDc = GetDC(IntPtr.Zero);
            if (screenDc == IntPtr.Zero)
            {
                throw new InvalidOperationException("Unable to acquire screen DC.");
            }

            Cols = Math.Max(1, CeilDiv(options.Width, options.SamplingRate));
            Rows = Math.Max(1, CeilDiv(options.Height, options.SamplingRate));
            output = new byte[Cols * Rows * 3];
            if (options.PointSample)
            {
                BuildSamplePoints();
            }
            else
            {
                BuildRegions();
            }
        }

        public BorderFrame CaptureFrame()
        {
            Array.Clear(output, 0, output.Length);
            if (options.PointSample)
            {
                foreach (var point in points)
                {
                    point.Capture(screenDc, output, Cols);
                }
            }
            else
            {
                foreach (var region in regions)
                {
                    region.Capture(screenDc, output, Cols, options.FastScale);
                }
            }
            return new BorderFrame(output);
        }

        public void Dispose()
        {
            foreach (var region in regions)
            {
                region.Dispose();
            }
            if (screenDc != IntPtr.Zero)
            {
                ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        private void BuildRegions()
        {
            var horizontalThickness = Math.Min(options.Height, Math.Max(1, options.EdgeThicknessPx));
            var verticalThickness = Math.Min(options.Width, Math.Max(1, options.EdgeThicknessPx));
            var verticalCols = Math.Max(1, CeilDiv(verticalThickness, options.SamplingRate));
            var horizontalRows = Math.Max(1, CeilDiv(horizontalThickness, options.SamplingRate));
            var rightOffset = Math.Max(0, Cols - verticalCols);
            var bottomOffset = Math.Max(0, Rows - horizontalRows);

            regions.Add(new CaptureRegion(options.X, options.Y, options.Width, horizontalThickness, Cols, horizontalRows, 0, 0));
            regions.Add(new CaptureRegion(options.X, options.Y, verticalThickness, options.Height, verticalCols, Rows, 0, 0));
            regions.Add(new CaptureRegion(options.X + options.Width - verticalThickness, options.Y, verticalThickness, options.Height, verticalCols, Rows, rightOffset, 0));

            if (options.EdgeNumber == 4)
            {
                regions.Add(new CaptureRegion(options.X, options.Y + options.Height - horizontalThickness, options.Width, horizontalThickness, Cols, horizontalRows, 0, bottomOffset));
            }
        }

        private void BuildSamplePoints()
        {
            var horizontalY = options.Y + Clamp(options.EdgeThicknessPx / 2, 0, options.Height - 1);
            var leftX = options.X + Clamp(options.EdgeThicknessPx / 2, 0, options.Width - 1);
            var rightX = options.X + options.Width - 1 - Clamp(options.EdgeThicknessPx / 2, 0, options.Width - 1);
            var bottomY = options.Y + options.Height - 1 - Clamp(options.EdgeThicknessPx / 2, 0, options.Height - 1);

            for (var col = 0; col < Cols; col += 1)
            {
                points.Add(new SamplePoint(ScaleIndex(options.X, options.Width, Cols, col), horizontalY, col, 0));
            }

            for (var row = 0; row < Rows; row += 1)
            {
                points.Add(new SamplePoint(leftX, ScaleIndex(options.Y, options.Height, Rows, row), 0, row));
                points.Add(new SamplePoint(rightX, ScaleIndex(options.Y, options.Height, Rows, row), Cols - 1, row));
            }

            if (options.EdgeNumber == 4)
            {
                for (var col = 0; col < Cols; col += 1)
                {
                    points.Add(new SamplePoint(ScaleIndex(options.X, options.Width, Cols, col), bottomY, col, Rows - 1));
                }
            }
        }

        private static int CeilDiv(int value, int divisor)
        {
            return Math.Max(1, (value + divisor - 1) / divisor);
        }

        private static int ScaleIndex(int origin, int length, int count, int index)
        {
            return origin + Clamp((int)Math.Round(((index + 0.5) * length) / Math.Max(1, count)), 0, length - 1);
        }

        private static int Clamp(int value, int min, int max)
        {
            return Math.Min(max, Math.Max(min, value));
        }
    }

    private sealed class SamplePoint
    {
        private readonly int sourceX;
        private readonly int sourceY;
        private readonly int targetCol;
        private readonly int targetRow;

        public SamplePoint(int sourceX, int sourceY, int targetCol, int targetRow)
        {
            this.sourceX = sourceX;
            this.sourceY = sourceY;
            this.targetCol = targetCol;
            this.targetRow = targetRow;
        }

        public void Capture(IntPtr screenDc, byte[] output, int outputCols)
        {
            var color = GetPixel(screenDc, sourceX, sourceY);
            var targetOffset = (targetRow * outputCols + targetCol) * 3;
            output[targetOffset] = (byte)(color & 0x000000FF);
            output[targetOffset + 1] = (byte)((color & 0x0000FF00) >> 8);
            output[targetOffset + 2] = (byte)((color & 0x00FF0000) >> 16);
        }
    }

    private sealed class CaptureRegion : IDisposable
    {
        private readonly int sourceX;
        private readonly int sourceY;
        private readonly int sourceWidth;
        private readonly int sourceHeight;
        private readonly int targetWidth;
        private readonly int targetHeight;
        private readonly int targetOffsetX;
        private readonly int targetOffsetY;
        private readonly Bitmap bitmap;
        private readonly byte[] pixels;

        public CaptureRegion(int sourceX, int sourceY, int sourceWidth, int sourceHeight, int targetWidth, int targetHeight, int targetOffsetX, int targetOffsetY)
        {
            this.sourceX = sourceX;
            this.sourceY = sourceY;
            this.sourceWidth = Math.Max(1, sourceWidth);
            this.sourceHeight = Math.Max(1, sourceHeight);
            this.targetWidth = Math.Max(1, targetWidth);
            this.targetHeight = Math.Max(1, targetHeight);
            this.targetOffsetX = Math.Max(0, targetOffsetX);
            this.targetOffsetY = Math.Max(0, targetOffsetY);
            bitmap = new Bitmap(this.targetWidth, this.targetHeight, PixelFormat.Format32bppArgb);
            pixels = new byte[this.targetWidth * this.targetHeight * 4];
        }

        public void Capture(IntPtr screenDc, byte[] output, int outputCols, bool fastScale)
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                var targetDc = graphics.GetHdc();
                try
                {
                    SetStretchBltMode(targetDc, fastScale ? ColorOnColor : Halftone);
                    StretchBlt(targetDc, 0, 0, targetWidth, targetHeight, screenDc, sourceX, sourceY, sourceWidth, sourceHeight, Srccopy);
                }
                finally
                {
                    graphics.ReleaseHdc(targetDc);
                }
            }

            var rect = new Rectangle(0, 0, targetWidth, targetHeight);
            var data = bitmap.LockBits(rect, ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            try
            {
                var bytes = Math.Abs(data.Stride) * data.Height;
                if (pixels.Length < bytes)
                {
                    throw new InvalidOperationException("Pixel buffer is too small.");
                }
                Marshal.Copy(data.Scan0, pixels, 0, bytes);
                for (var row = 0; row < targetHeight; row += 1)
                {
                    for (var col = 0; col < targetWidth; col += 1)
                    {
                        var sourceOffset = row * data.Stride + col * 4;
                        var targetCol = targetOffsetX + col;
                        var targetRow = targetOffsetY + row;
                        var targetOffset = (targetRow * outputCols + targetCol) * 3;
                        output[targetOffset] = pixels[sourceOffset + 2];
                        output[targetOffset + 1] = pixels[sourceOffset + 1];
                        output[targetOffset + 2] = pixels[sourceOffset];
                    }
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }
        }

        public void Dispose()
        {
            bitmap.Dispose();
        }
    }

    private sealed class BorderFrame
    {
        private readonly byte[] rgb;
        private readonly int signature;

        public BorderFrame(byte[] source)
        {
            rgb = new byte[source.Length];
            Buffer.BlockCopy(source, 0, rgb, 0, source.Length);
            signature = ComputeSignature(rgb);
        }

        public string ToJson(string displayId, int width, int height, int cols, int rows, double elapsedMs)
        {
            return string.Format(
                System.Globalization.CultureInfo.InvariantCulture,
                "{{\"type\":\"frame\",\"backend\":\"gdi-stretchblt\",\"displayId\":\"{0}\",\"width\":{1},\"height\":{2},\"cols\":{3},\"rows\":{4},\"elapsedMs\":{5:0.###},\"signature\":\"{6}\",\"colors\":\"{7}\"}}",
                Escape(displayId),
                width,
                height,
                cols,
                rows,
                elapsedMs,
                signature,
                Convert.ToBase64String(rgb));
        }

        private static int ComputeSignature(byte[] bytes)
        {
            unchecked
            {
                var hash = 17;
                var step = Math.Max(1, bytes.Length / 96);
                for (var index = 0; index < bytes.Length; index += step)
                {
                    hash = hash * 31 + bytes[index];
                }
                return hash;
            }
        }
    }
}
