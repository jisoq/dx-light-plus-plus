#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

template <typename T>
static void releaseCom(T*& value)
{
    if (value)
    {
        value->Release();
        value = nullptr;
    }
}

struct Options
{
    std::string displayId = "DISPLAY1";
    int x = 0;
    int y = 0;
    int width = 1;
    int height = 1;
    int samplingRate = 80;
    int edgeThicknessPx = 80;
    int edgeNumber = 3;
    int intervalMs = 50;
    int frames = 0;
};

struct OutputSelection
{
    IDXGIAdapter1* adapter = nullptr;
    IDXGIOutput* output = nullptr;
    DXGI_OUTPUT_DESC desc{};
    int ordinal = 0;
};

static int clampInt(int value, int minValue, int maxValue)
{
    return std::min(maxValue, std::max(minValue, value));
}

static int ceilDiv(int value, int divisor)
{
    return std::max(1, (value + divisor - 1) / divisor);
}

static int parseInt(const std::map<std::string, std::string>& values, const std::string& key, int fallback)
{
    auto found = values.find(key);
    if (found == values.end())
    {
        return fallback;
    }
    return std::atoi(found->second.c_str());
}

static std::string parseString(const std::map<std::string, std::string>& values, const std::string& key, const std::string& fallback)
{
    auto found = values.find(key);
    return found == values.end() ? fallback : found->second;
}

static Options parseOptions(int argc, char** argv)
{
    std::map<std::string, std::string> values;
    for (int index = 1; index < argc; ++index)
    {
        std::string key = argv[index];
        if (key.rfind("--", 0) != 0)
        {
            continue;
        }
        key = key.substr(2);
        if (index + 1 < argc && std::string(argv[index + 1]).rfind("--", 0) != 0)
        {
            values[key] = argv[++index];
        }
        else
        {
            values[key] = "true";
        }
    }

    Options options;
    options.displayId = parseString(values, "displayId", options.displayId);
    options.x = parseInt(values, "x", options.x);
    options.y = parseInt(values, "y", options.y);
    options.width = std::max(1, parseInt(values, "width", options.width));
    options.height = std::max(1, parseInt(values, "height", options.height));
    options.samplingRate = clampInt(parseInt(values, "samplingRate", options.samplingRate), 20, 240);
    options.edgeThicknessPx = clampInt(parseInt(values, "edgeThicknessPx", options.samplingRate), 1, std::max(options.width, options.height));
    options.edgeNumber = parseInt(values, "edgeNumber", options.edgeNumber) == 4 ? 4 : 3;
    options.intervalMs = clampInt(parseInt(values, "intervalMs", options.intervalMs), 8, 1000);
    options.frames = std::max(0, parseInt(values, "frames", options.frames));
    return options;
}

static std::string escapeJson(const std::string& value)
{
    std::ostringstream output;
    for (char ch : value)
    {
        switch (ch)
        {
        case '\\': output << "\\\\"; break;
        case '"': output << "\\\""; break;
        case '\n': output << "\\n"; break;
        case '\r': output << "\\r"; break;
        case '\t': output << "\\t"; break;
        default: output << ch; break;
        }
    }
    return output.str();
}

static std::string base64Encode(const std::vector<uint8_t>& bytes)
{
    static const char* alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    output.reserve(((bytes.size() + 2) / 3) * 4);
    for (size_t index = 0; index < bytes.size(); index += 3)
    {
        const uint32_t a = bytes[index];
        const uint32_t b = index + 1 < bytes.size() ? bytes[index + 1] : 0;
        const uint32_t c = index + 2 < bytes.size() ? bytes[index + 2] : 0;
        const uint32_t triple = (a << 16) | (b << 8) | c;
        output.push_back(alphabet[(triple >> 18) & 0x3F]);
        output.push_back(alphabet[(triple >> 12) & 0x3F]);
        output.push_back(index + 1 < bytes.size() ? alphabet[(triple >> 6) & 0x3F] : '=');
        output.push_back(index + 2 < bytes.size() ? alphabet[triple & 0x3F] : '=');
    }
    return output;
}

static int signatureFor(const std::vector<uint8_t>& bytes)
{
    int hash = 17;
    const size_t step = std::max<size_t>(1, bytes.size() / 96);
    for (size_t index = 0; index < bytes.size(); index += step)
    {
        hash = hash * 31 + bytes[index];
    }
    return hash;
}

static int displayOrdinal(const std::string& displayId)
{
    if (displayId.rfind("DISPLAY", 0) != 0)
    {
        return 0;
    }
    const int parsed = std::atoi(displayId.c_str() + 7);
    return std::max(0, parsed - 1);
}

static OutputSelection selectOutput(const Options& options)
{
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory));
    if (FAILED(hr))
    {
        throw std::runtime_error("CreateDXGIFactory1 failed");
    }

    const int wantedOrdinal = displayOrdinal(options.displayId);
    int ordinal = 0;
    OutputSelection selected;

    for (UINT adapterIndex = 0; !selected.output; ++adapterIndex)
    {
        IDXGIAdapter1* adapter = nullptr;
        if (factory->EnumAdapters1(adapterIndex, &adapter) == DXGI_ERROR_NOT_FOUND)
        {
            break;
        }

        for (UINT outputIndex = 0; !selected.output; ++outputIndex)
        {
            IDXGIOutput* output = nullptr;
            if (adapter->EnumOutputs(outputIndex, &output) == DXGI_ERROR_NOT_FOUND)
            {
                break;
            }

            DXGI_OUTPUT_DESC desc{};
            output->GetDesc(&desc);
            if (ordinal == wantedOrdinal)
            {
                selected.adapter = adapter;
                selected.output = output;
                selected.desc = desc;
                selected.ordinal = ordinal;
                adapter = nullptr;
                output = nullptr;
            }

            releaseCom(output);
            ordinal += 1;
        }

        releaseCom(adapter);
    }

    releaseCom(factory);

    if (!selected.output || !selected.adapter)
    {
        throw std::runtime_error("No matching DXGI output found");
    }
    return selected;
}

class DxgiSampler
{
public:
    explicit DxgiSampler(const Options& options)
        : options_(options),
          cols_(ceilDiv(options.width, options.samplingRate)),
          rows_(ceilDiv(options.height, options.samplingRate)),
          horizontalBandRows_(clampInt(ceilDiv(options.edgeThicknessPx, options.samplingRate), 1, rows_)),
          verticalBandCols_(clampInt(ceilDiv(options.edgeThicknessPx, options.samplingRate), 1, cols_)),
          rgb_(cols_ * rows_ * 3)
    {
        selection_ = selectOutput(options);
        const RECT& rect = selection_.desc.DesktopCoordinates;
        physicalWidth_ = std::max(1L, rect.right - rect.left);
        physicalHeight_ = std::max(1L, rect.bottom - rect.top);
        scaleX_ = static_cast<double>(physicalWidth_) / std::max(1, options.width);
        scaleY_ = static_cast<double>(physicalHeight_) / std::max(1, options.height);
        initializeDevice();
    }

    ~DxgiSampler()
    {
        releaseCom(duplication_);
        releaseCom(context_);
        releaseCom(device_);
        releaseCom(selection_.output);
        releaseCom(selection_.adapter);
        for (auto& texture : staging_)
        {
            releaseCom(texture);
        }
    }

    int cols() const { return cols_; }
    int rows() const { return rows_; }
    int physicalWidth() const { return physicalWidth_; }
    int physicalHeight() const { return physicalHeight_; }
    bool contentBoundsActive() const { return lastContentBounds_.active; }
    int contentBoundsLeft() const { return lastContentBounds_.left; }
    int contentBoundsRight() const { return lastContentBounds_.right; }

    const std::vector<uint8_t>& captureFrame()
    {
        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        IDXGIResource* resource = nullptr;
        HRESULT hr = duplication_->AcquireNextFrame(1000, &frameInfo, &resource);
        if (FAILED(hr))
        {
            if (hr == DXGI_ERROR_WAIT_TIMEOUT)
            {
                return rgb_;
            }
            throw std::runtime_error("AcquireNextFrame failed");
        }

        ID3D11Texture2D* frame = nullptr;
        hr = resource->QueryInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&frame));
        releaseCom(resource);
        if (FAILED(hr))
        {
            duplication_->ReleaseFrame();
            throw std::runtime_error("Frame QueryInterface failed");
        }

        D3D11_TEXTURE2D_DESC frameDesc{};
        frame->GetDesc(&frameDesc);
        format_ = frameDesc.Format;

        try
        {
            std::fill(rgb_.begin(), rgb_.end(), 0);
            const ContentBounds content = detectContentBounds(frame);
            lastContentBounds_ = content;
            const int horizontalLeft = content.active ? content.left : 0;
            const int horizontalRight = content.active ? content.right : physicalWidth_;

            const std::vector<uint8_t> topLine = readHorizontalLine(frame, topY(), horizontalLeft, horizontalRight);
            writeHorizontalBand(topLine, 0, horizontalBandRows_);

            const std::vector<uint8_t> leftLine = readVerticalLine(frame, content.active ? content.leftSampleX : leftX(), LeftLine);
            const std::vector<uint8_t> rightLine = readVerticalLine(frame, content.active ? content.rightSampleX : rightX(), RightLine);
            writeVerticalBand(leftLine, 0, verticalBandCols_);
            writeVerticalBand(rightLine, cols_ - verticalBandCols_, cols_);
            if (options_.edgeNumber == 4)
            {
                const std::vector<uint8_t> bottomLine = readHorizontalLine(frame, bottomY(), horizontalLeft, horizontalRight);
                writeHorizontalBand(bottomLine, rows_ - horizontalBandRows_, rows_);
            }
        }
        catch (...)
        {
            releaseCom(frame);
            duplication_->ReleaseFrame();
            throw;
        }

        releaseCom(frame);
        duplication_->ReleaseFrame();
        return rgb_;
    }

private:
    enum StagingSlot
    {
        TopLine = 0,
        LeftLine = 1,
        RightLine = 2,
        BottomLine = 3,
        SlotCount = 4
    };

    struct ContentBounds
    {
        bool active = false;
        int left = 0;
        int right = 1;
        int leftSampleX = 0;
        int rightSampleX = 0;
    };

    Options options_;
    OutputSelection selection_;
    ID3D11Device* device_ = nullptr;
    ID3D11DeviceContext* context_ = nullptr;
    IDXGIOutputDuplication* duplication_ = nullptr;
    IDXGIOutput1* output1_ = nullptr;
    ID3D11Texture2D* staging_[SlotCount]{};
    DXGI_FORMAT format_ = DXGI_FORMAT_B8G8R8A8_UNORM;
    int cols_ = 1;
    int rows_ = 1;
    int horizontalBandRows_ = 1;
    int verticalBandCols_ = 1;
    int physicalWidth_ = 1;
    int physicalHeight_ = 1;
    double scaleX_ = 1.0;
    double scaleY_ = 1.0;
    std::vector<uint8_t> rgb_;
    int contentBoundsHoldFrames_ = 0;
    ContentBounds lastContentBounds_;

    void initializeDevice()
    {
        const D3D_FEATURE_LEVEL levels[] = {
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0,
        };
        D3D_FEATURE_LEVEL selectedLevel{};
        HRESULT hr = D3D11CreateDevice(
            selection_.adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            nullptr,
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            levels,
            static_cast<UINT>(sizeof(levels) / sizeof(levels[0])),
            D3D11_SDK_VERSION,
            &device_,
            &selectedLevel,
            &context_);
        if (FAILED(hr))
        {
            throw std::runtime_error("D3D11CreateDevice failed");
        }

        hr = selection_.output->QueryInterface(__uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1_));
        if (FAILED(hr))
        {
            throw std::runtime_error("IDXGIOutput1 QueryInterface failed");
        }

        hr = output1_->DuplicateOutput(device_, &duplication_);
        releaseCom(output1_);
        if (FAILED(hr))
        {
            throw std::runtime_error("DuplicateOutput failed");
        }
    }

    int edgePhysicalX() const
    {
        return clampInt(static_cast<int>(std::round(options_.edgeThicknessPx * scaleX_ / 2.0)), 0, physicalWidth_ - 1);
    }

    int edgePhysicalY() const
    {
        return clampInt(static_cast<int>(std::round(options_.edgeThicknessPx * scaleY_ / 2.0)), 0, physicalHeight_ - 1);
    }

    int leftX() const { return edgePhysicalX(); }
    int rightX() const { return physicalWidth_ - 1 - edgePhysicalX(); }
    int topY() const { return edgePhysicalY(); }
    int bottomY() const { return physicalHeight_ - 1 - edgePhysicalY(); }

    ContentBounds detectContentBounds(ID3D11Texture2D* frame)
    {
        ContentBounds bounds;
        bounds.leftSampleX = leftX();
        bounds.rightSampleX = rightX();

        const int active16x9Width = static_cast<int>(std::round(physicalHeight_ * 16.0 / 9.0));
        const int horizontalInset = (physicalWidth_ - active16x9Width) / 2;
        if (active16x9Width <= 0 || horizontalInset <= options_.edgeThicknessPx)
        {
            contentBoundsHoldFrames_ = 0;
            return bounds;
        }

        bounds.left = clampInt(horizontalInset, 0, physicalWidth_ - 1);
        bounds.right = clampInt(physicalWidth_ - horizontalInset, bounds.left + 1, physicalWidth_);
        bounds.leftSampleX = clampInt(bounds.left + edgePhysicalX(), 0, physicalWidth_ - 1);
        bounds.rightSampleX = clampInt(bounds.right - 1 - edgePhysicalX(), 0, physicalWidth_ - 1);

        const std::vector<uint8_t> leftEdge = readVerticalLine(frame, leftX(), LeftLine);
        const std::vector<uint8_t> rightEdge = readVerticalLine(frame, rightX(), RightLine);
        const std::vector<uint8_t> leftContent = readVerticalLine(frame, bounds.leftSampleX, LeftLine);
        const std::vector<uint8_t> rightContent = readVerticalLine(frame, bounds.rightSampleX, RightLine);

        const bool sideBarsDetected =
            isMostlyBlack(leftEdge) &&
            isMostlyBlack(rightEdge) &&
            !isMostlyBlack(leftContent) &&
            !isMostlyBlack(rightContent);
        if (sideBarsDetected)
        {
            contentBoundsHoldFrames_ = 120;
        }
        else if (contentBoundsHoldFrames_ > 0)
        {
            contentBoundsHoldFrames_ -= 1;
        }

        bounds.active = sideBarsDetected || contentBoundsHoldFrames_ > 0;
        return bounds;
    }

    bool isMostlyBlack(const std::vector<uint8_t>& line) const
    {
        if (line.empty())
        {
            return true;
        }

        int blackPixels = 0;
        int totalPixels = 0;
        for (size_t index = 0; index + 2 < line.size(); index += 3)
        {
            const int sum = static_cast<int>(line[index]) + static_cast<int>(line[index + 1]) + static_cast<int>(line[index + 2]);
            if (sum <= 30)
            {
                blackPixels += 1;
            }
            totalPixels += 1;
        }

        return totalPixels > 0 && blackPixels * 100 >= totalPixels * 85;
    }

    ID3D11Texture2D* ensureStaging(StagingSlot slot, int width, int height)
    {
        ID3D11Texture2D* texture = staging_[slot];
        if (texture)
        {
            D3D11_TEXTURE2D_DESC existing{};
            texture->GetDesc(&existing);
            if (static_cast<int>(existing.Width) == width && static_cast<int>(existing.Height) == height && existing.Format == format_)
            {
                return texture;
            }
            releaseCom(staging_[slot]);
        }

        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = static_cast<UINT>(width);
        desc.Height = static_cast<UINT>(height);
        desc.MipLevels = 1;
        desc.ArraySize = 1;
        desc.Format = format_;
        desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

        HRESULT hr = device_->CreateTexture2D(&desc, nullptr, &staging_[slot]);
        if (FAILED(hr))
        {
            throw std::runtime_error("CreateTexture2D staging failed");
        }
        return staging_[slot];
    }

    std::vector<uint8_t> readHorizontalLine(ID3D11Texture2D* frame, int y, int sourceLeft, int sourceRight)
    {
        sourceLeft = clampInt(sourceLeft, 0, physicalWidth_ - 1);
        sourceRight = clampInt(sourceRight, sourceLeft + 1, physicalWidth_);
        const int sourceWidth = std::max(1, sourceRight - sourceLeft);
        ID3D11Texture2D* staging = ensureStaging(y <= physicalHeight_ / 2 ? TopLine : BottomLine, sourceWidth, 1);
        D3D11_BOX box{};
        box.left = static_cast<UINT>(sourceLeft);
        box.top = static_cast<UINT>(clampInt(y, 0, physicalHeight_ - 1));
        box.front = 0;
        box.right = static_cast<UINT>(sourceRight);
        box.bottom = box.top + 1;
        box.back = 1;
        context_->CopySubresourceRegion(staging, 0, 0, 0, 0, frame, 0, &box);

        D3D11_MAPPED_SUBRESOURCE mapped{};
        HRESULT hr = context_->Map(staging, 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(hr))
        {
            throw std::runtime_error("Map horizontal staging failed");
        }

        std::vector<uint8_t> line(cols_ * 3);
        const auto* data = static_cast<const uint8_t*>(mapped.pData);
        for (int col = 0; col < cols_; ++col)
        {
            const int sourceX = clampInt(static_cast<int>(std::round(((col + 0.5) * sourceWidth) / cols_)), 0, sourceWidth - 1);
            readPixel(data + sourceX * 4, &line[col * 3]);
        }
        context_->Unmap(staging, 0);
        return line;
    }

    std::vector<uint8_t> readVerticalLine(ID3D11Texture2D* frame, int x, StagingSlot slot)
    {
        ID3D11Texture2D* staging = ensureStaging(slot, 1, physicalHeight_);
        D3D11_BOX box{};
        box.left = static_cast<UINT>(clampInt(x, 0, physicalWidth_ - 1));
        box.top = 0;
        box.front = 0;
        box.right = box.left + 1;
        box.bottom = static_cast<UINT>(physicalHeight_);
        box.back = 1;
        context_->CopySubresourceRegion(staging, 0, 0, 0, 0, frame, 0, &box);

        D3D11_MAPPED_SUBRESOURCE mapped{};
        HRESULT hr = context_->Map(staging, 0, D3D11_MAP_READ, 0, &mapped);
        if (FAILED(hr))
        {
            throw std::runtime_error("Map vertical staging failed");
        }

        std::vector<uint8_t> line(rows_ * 3);
        const auto* data = static_cast<const uint8_t*>(mapped.pData);
        for (int row = 0; row < rows_; ++row)
        {
            const int sourceY = clampInt(static_cast<int>(std::round(((row + 0.5) * physicalHeight_) / rows_)), 0, physicalHeight_ - 1);
            readPixel(data + sourceY * mapped.RowPitch, &line[row * 3]);
        }
        context_->Unmap(staging, 0);
        return line;
    }

    void writeHorizontalBand(const std::vector<uint8_t>& line, int targetRowStart, int targetRowEnd)
    {
        targetRowStart = clampInt(targetRowStart, 0, rows_ - 1);
        targetRowEnd = clampInt(targetRowEnd, targetRowStart + 1, rows_);
        for (int row = targetRowStart; row < targetRowEnd; ++row)
        {
            for (int col = 0; col < cols_; ++col)
            {
                const int sourceOffset = col * 3;
                const int targetOffset = (row * cols_ + col) * 3;
                rgb_[targetOffset] = line[sourceOffset];
                rgb_[targetOffset + 1] = line[sourceOffset + 1];
                rgb_[targetOffset + 2] = line[sourceOffset + 2];
            }
        }
    }

    void writeVerticalBand(const std::vector<uint8_t>& line, int targetColStart, int targetColEnd)
    {
        targetColStart = clampInt(targetColStart, 0, cols_ - 1);
        targetColEnd = clampInt(targetColEnd, targetColStart + 1, cols_);
        for (int row = 0; row < rows_; ++row)
        {
            for (int col = targetColStart; col < targetColEnd; ++col)
            {
                const int sourceOffset = row * 3;
                const int targetOffset = (row * cols_ + col) * 3;
                rgb_[targetOffset] = line[sourceOffset];
                rgb_[targetOffset + 1] = line[sourceOffset + 1];
                rgb_[targetOffset + 2] = line[sourceOffset + 2];
            }
        }
    }

    void readPixel(const uint8_t* pixel, uint8_t* output) const
    {
        if (format_ == DXGI_FORMAT_R8G8B8A8_UNORM || format_ == DXGI_FORMAT_R8G8B8A8_UNORM_SRGB)
        {
            output[0] = pixel[0];
            output[1] = pixel[1];
            output[2] = pixel[2];
            return;
        }

        output[0] = pixel[2];
        output[1] = pixel[1];
        output[2] = pixel[0];
    }
};

int main(int argc, char** argv)
{
    try
    {
        Options options = parseOptions(argc, argv);
        DxgiSampler sampler(options);
        std::cerr << "DxLightDxgiBorderSampler backend=dxgi-desktop-duplication display=" << options.displayId
                  << " physical=" << sampler.physicalWidth() << "x" << sampler.physicalHeight()
                  << " grid=" << sampler.cols() << "x" << sampler.rows()
                  << " interval=" << options.intervalMs << "ms" << std::endl;
        std::cout << "{\"type\":\"ready\",\"backend\":\"dxgi-desktop-duplication\",\"displayId\":\""
                  << escapeJson(options.displayId) << "\",\"physicalWidth\":" << sampler.physicalWidth()
                  << ",\"physicalHeight\":" << sampler.physicalHeight() << "}" << std::endl;

        int frameCount = 0;
        while (options.frames <= 0 || frameCount < options.frames)
        {
            const auto started = std::chrono::steady_clock::now();
            const std::vector<uint8_t>& frame = sampler.captureFrame();
            const auto finished = std::chrono::steady_clock::now();
            const double elapsedMs = std::chrono::duration<double, std::milli>(finished - started).count();

            std::cout << "{\"type\":\"frame\",\"backend\":\"dxgi-desktop-duplication\",\"displayId\":\""
                      << escapeJson(options.displayId)
                      << "\",\"width\":" << options.width
                      << ",\"height\":" << options.height
                      << ",\"physicalWidth\":" << sampler.physicalWidth()
                      << ",\"physicalHeight\":" << sampler.physicalHeight()
                      << ",\"cols\":" << sampler.cols()
                      << ",\"rows\":" << sampler.rows()
                      << ",\"elapsedMs\":" << elapsedMs
                      << ",\"contentBoundsActive\":" << (sampler.contentBoundsActive() ? "true" : "false")
                      << ",\"contentLeft\":" << sampler.contentBoundsLeft()
                      << ",\"contentRight\":" << sampler.contentBoundsRight()
                      << ",\"signature\":\"" << signatureFor(frame)
                      << "\",\"colors\":\"" << base64Encode(frame)
                      << "\"}" << std::endl;

            frameCount += 1;
            if (options.frames > 0 && frameCount >= options.frames)
            {
                break;
            }

            const auto sleepMs = std::max(1, options.intervalMs - static_cast<int>(std::round(elapsedMs)));
            std::this_thread::sleep_for(std::chrono::milliseconds(sleepMs));
        }
        return 0;
    }
    catch (const std::exception& error)
    {
        std::cerr << error.what() << std::endl;
        return 1;
    }
}
