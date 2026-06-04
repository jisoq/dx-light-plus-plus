#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <lowlevelmonitorconfigurationapi.h>
#include <physicalmonitorenumerationapi.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iomanip>
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
    int averageRadiusPx = 12;
    int smoothingAlphaPercent = 35;
    int deadband = 10;
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
    options.averageRadiusPx = clampInt(parseInt(values, "averageRadiusPx", options.averageRadiusPx), 0, 80);
    options.smoothingAlphaPercent = clampInt(parseInt(values, "smoothingAlphaPercent", options.smoothingAlphaPercent), 1, 100);
    options.deadband = clampInt(parseInt(values, "deadband", options.deadband), 0, 96);
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

static const char* hresultName(HRESULT hr)
{
    switch (hr)
    {
    case S_OK: return "S_OK";
    case E_ACCESSDENIED: return "E_ACCESSDENIED";
    case E_INVALIDARG: return "E_INVALIDARG";
    case DXGI_ERROR_ACCESS_LOST: return "DXGI_ERROR_ACCESS_LOST";
    case DXGI_ERROR_DEVICE_REMOVED: return "DXGI_ERROR_DEVICE_REMOVED";
    case DXGI_ERROR_DEVICE_RESET: return "DXGI_ERROR_DEVICE_RESET";
    case DXGI_ERROR_INVALID_CALL: return "DXGI_ERROR_INVALID_CALL";
    case DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: return "DXGI_ERROR_NOT_CURRENTLY_AVAILABLE";
    case DXGI_ERROR_NOT_FOUND: return "DXGI_ERROR_NOT_FOUND";
    case DXGI_ERROR_UNSUPPORTED: return "DXGI_ERROR_UNSUPPORTED";
    case DXGI_ERROR_WAIT_TIMEOUT: return "DXGI_ERROR_WAIT_TIMEOUT";
    default: return "HRESULT";
    }
}

static std::string describeHresult(HRESULT hr)
{
    std::ostringstream output;
    output << hresultName(hr) << " (0x"
           << std::uppercase << std::hex << std::setw(8) << std::setfill('0')
           << static_cast<uint32_t>(hr) << ")";
    return output.str();
}

static bool isDuplicationSessionLoss(HRESULT hr)
{
    return hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_DEVICE_REMOVED || hr == DXGI_ERROR_DEVICE_RESET;
}

static bool shouldRetryDuplicateOutput(HRESULT hr)
{
    return hr != DXGI_ERROR_UNSUPPORTED && hr != E_INVALIDARG;
}

enum class MonitorPowerProbeResult
{
    Unknown,
    On,
    LowPower
};

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

static bool wideEqualsIgnoreCase(const WCHAR* left, const WCHAR* right)
{
    return CompareStringOrdinal(left, -1, right, -1, TRUE) == CSTR_EQUAL;
}

static bool displayConfigTargetIsAvailable(const WCHAR* gdiDeviceName, std::string& reason)
{
    UINT32 pathCount = 0;
    UINT32 modeCount = 0;
    LONG result = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount);
    if (result != ERROR_SUCCESS || pathCount == 0)
    {
        return true;
    }

    std::vector<DISPLAYCONFIG_PATH_INFO> paths(pathCount);
    std::vector<DISPLAYCONFIG_MODE_INFO> modes(modeCount);
    result = QueryDisplayConfig(
        QDC_ONLY_ACTIVE_PATHS,
        &pathCount,
        paths.data(),
        &modeCount,
        modes.data(),
        nullptr);
    if (result != ERROR_SUCCESS)
    {
        return true;
    }

    bool matchedSource = false;
    for (UINT32 index = 0; index < pathCount; ++index)
    {
        const DISPLAYCONFIG_PATH_INFO& pathInfo = paths[index];
        DISPLAYCONFIG_SOURCE_DEVICE_NAME sourceName{};
        sourceName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        sourceName.header.size = sizeof(sourceName);
        sourceName.header.adapterId = pathInfo.sourceInfo.adapterId;
        sourceName.header.id = pathInfo.sourceInfo.id;

        if (DisplayConfigGetDeviceInfo(&sourceName.header) != ERROR_SUCCESS ||
            !wideEqualsIgnoreCase(sourceName.viewGdiDeviceName, gdiDeviceName))
        {
            continue;
        }

        matchedSource = true;
        if ((pathInfo.flags & DISPLAYCONFIG_PATH_ACTIVE) == 0)
        {
            reason = "display path is not active";
            return false;
        }
        if (!pathInfo.targetInfo.targetAvailable)
        {
            reason = "display target is not available";
            return false;
        }

        DISPLAYCONFIG_TARGET_DEVICE_NAME targetName{};
        targetName.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        targetName.header.size = sizeof(targetName);
        targetName.header.adapterId = pathInfo.targetInfo.adapterId;
        targetName.header.id = pathInfo.targetInfo.id;
        if (DisplayConfigGetDeviceInfo(&targetName.header) == ERROR_SUCCESS &&
            targetName.monitorFriendlyDeviceName[0] == L'\0' &&
            targetName.monitorDevicePath[0] == L'\0')
        {
            reason = "display target has no connected monitor";
            return false;
        }

        return true;
    }

    if (!matchedSource)
    {
        reason = "display source is not active";
        return false;
    }
    return true;
}

static std::string hexMonitorPowerMode(DWORD value)
{
    std::ostringstream output;
    output << "0x"
           << std::uppercase << std::hex << std::setw(2) << std::setfill('0')
           << value;
    return output.str();
}

static bool isKnownLowPowerMonitorMode(DWORD value)
{
    return value >= 0x02 && value <= 0x05;
}

static MonitorPowerProbeResult queryPhysicalMonitorPower(HMONITOR monitor, DWORD& powerMode)
{
    if (!monitor)
    {
        return MonitorPowerProbeResult::Unknown;
    }

    DWORD physicalMonitorCount = 0;
    if (!GetNumberOfPhysicalMonitorsFromHMONITOR(monitor, &physicalMonitorCount) ||
        physicalMonitorCount == 0)
    {
        return MonitorPowerProbeResult::Unknown;
    }

    std::vector<PHYSICAL_MONITOR> physicalMonitors(physicalMonitorCount);
    if (!GetPhysicalMonitorsFromHMONITOR(monitor, physicalMonitorCount, physicalMonitors.data()))
    {
        return MonitorPowerProbeResult::Unknown;
    }

    MonitorPowerProbeResult result = MonitorPowerProbeResult::Unknown;
    DWORD lowPowerMode = 0;
    for (const PHYSICAL_MONITOR& physicalMonitor : physicalMonitors)
    {
        DWORD currentValue = 0;
        DWORD maximumValue = 0;
        MC_VCP_CODE_TYPE codeType{};
        if (!GetVCPFeatureAndVCPFeatureReply(
            physicalMonitor.hPhysicalMonitor,
            0xD6,
            &codeType,
            &currentValue,
            &maximumValue))
        {
            continue;
        }

        if (currentValue == 0x01)
        {
            result = MonitorPowerProbeResult::On;
            break;
        }
        if (isKnownLowPowerMonitorMode(currentValue))
        {
            result = MonitorPowerProbeResult::LowPower;
            lowPowerMode = currentValue;
        }
    }

    DestroyPhysicalMonitors(physicalMonitorCount, physicalMonitors.data());
    if (result == MonitorPowerProbeResult::LowPower)
    {
        powerMode = lowPowerMode;
    }
    return result;
}

static OutputSelection selectOutput(const Options& options)
{
    IDXGIFactory1* factory = nullptr;
    HRESULT hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(&factory));
    if (FAILED(hr))
    {
        throw std::runtime_error("CreateDXGIFactory1 failed: " + describeHresult(hr));
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
          rgb_(cols_ * rows_ * 3),
          previousRgb_(cols_ * rows_ * 3)
    {
        refreshOutputSelection();
        initializeDevice();
    }

    ~DxgiSampler()
    {
        releaseDeviceResources();
        releaseCom(selection_.output);
        releaseCom(selection_.adapter);
    }

    int cols() const { return cols_; }
    int rows() const { return rows_; }
    int physicalWidth() const { return physicalWidth_; }
    int physicalHeight() const { return physicalHeight_; }
    DXGI_FORMAT format() const { return format_; }
    int averageRadiusPx() const { return options_.averageRadiusPx; }
    int smoothingAlphaPercent() const { return options_.smoothingAlphaPercent; }
    int deadband() const { return options_.deadband; }
    bool displayActive() const { return displayActive_; }
    const std::string& displayStatusReason() const { return displayStatusReason_; }
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
                std::string reason;
                if (!isSelectedOutputAvailable(reason))
                {
                    std::cerr << "Blanking DXGI frame because selected output is inactive: "
                              << reason << std::endl;
                    return blankFrame(reason);
                }
                displayActive_ = true;
                displayStatusReason_.clear();
                return rgb_;
            }
            if (isDuplicationSessionLoss(hr))
            {
                const std::string reason = "duplication session lost: " + describeHresult(hr);
                std::cerr << "Recovering DXGI duplication after AcquireNextFrame failed: "
                          << describeHresult(hr) << std::endl;
                blankFrame(reason);
                resetDeviceResources();
                return rgb_;
            }
            throw std::runtime_error("AcquireNextFrame failed: " + describeHresult(hr));
        }

        ID3D11Texture2D* frame = nullptr;
        hr = resource->QueryInterface(__uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&frame));
        releaseCom(resource);
        if (FAILED(hr))
        {
            duplication_->ReleaseFrame();
            throw std::runtime_error("Frame QueryInterface failed: " + describeHresult(hr));
        }

        D3D11_TEXTURE2D_DESC frameDesc{};
        frame->GetDesc(&frameDesc);
        format_ = frameDesc.Format;
        ensureSupportedFormat();

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
            smoothFrame();
            displayActive_ = true;
            displayStatusReason_.clear();
            monitorPowerProbeFailureCount_ = 0;
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
    int averageRadiusX_ = 0;
    int averageRadiusY_ = 0;
    std::vector<uint8_t> rgb_;
    std::vector<uint8_t> previousRgb_;
    bool hasPreviousRgb_ = false;
    bool displayActive_ = true;
    std::string displayStatusReason_;
    bool monitorPowerProbeEverSucceeded_ = false;
    int monitorPowerProbeFailureCount_ = 0;
    int contentBoundsHoldFrames_ = 0;
    ContentBounds lastContentBounds_;

    void releaseStagingTextures()
    {
        for (auto& texture : staging_)
        {
            releaseCom(texture);
        }
    }

    void releaseDuplicationResources()
    {
        releaseCom(duplication_);
        releaseCom(output1_);
        releaseStagingTextures();
    }

    void releaseDeviceResources()
    {
        releaseDuplicationResources();
        releaseCom(context_);
        releaseCom(device_);
    }

    void updatePhysicalMetrics()
    {
        const RECT& rect = selection_.desc.DesktopCoordinates;
        physicalWidth_ = std::max(1L, rect.right - rect.left);
        physicalHeight_ = std::max(1L, rect.bottom - rect.top);
        scaleX_ = static_cast<double>(physicalWidth_) / std::max(1, options_.width);
        scaleY_ = static_cast<double>(physicalHeight_) / std::max(1, options_.height);
        averageRadiusX_ = clampInt(static_cast<int>(std::round(options_.averageRadiusPx * scaleX_)), 0, std::max(0, physicalWidth_ / 8));
        averageRadiusY_ = clampInt(static_cast<int>(std::round(options_.averageRadiusPx * scaleY_)), 0, std::max(0, physicalHeight_ / 8));
    }

    void refreshOutputSelection()
    {
        releaseCom(selection_.output);
        releaseCom(selection_.adapter);
        selection_ = selectOutput(options_);
        updatePhysicalMetrics();
    }

    bool isSelectedOutputAvailable(std::string& reason)
    {
        DXGI_OUTPUT_DESC desc{};
        HRESULT hr = selection_.output->GetDesc(&desc);
        if (FAILED(hr))
        {
            reason = "selected output description is unavailable: " + describeHresult(hr);
            return false;
        }

        selection_.desc = desc;
        updatePhysicalMetrics();
        if (!desc.AttachedToDesktop)
        {
            reason = "selected output is not attached to the desktop";
            return false;
        }

        if (!displayConfigTargetIsAvailable(desc.DeviceName, reason))
        {
            return false;
        }

        DWORD powerMode = 0;
        const MonitorPowerProbeResult powerProbe = queryPhysicalMonitorPower(desc.Monitor, powerMode);
        if (powerProbe == MonitorPowerProbeResult::On)
        {
            monitorPowerProbeEverSucceeded_ = true;
            monitorPowerProbeFailureCount_ = 0;
            return true;
        }
        if (powerProbe == MonitorPowerProbeResult::LowPower)
        {
            monitorPowerProbeEverSucceeded_ = true;
            monitorPowerProbeFailureCount_ = 0;
            reason = "physical monitor power mode is low-power (" + hexMonitorPowerMode(powerMode) + ")";
            return false;
        }

        if (monitorPowerProbeEverSucceeded_)
        {
            monitorPowerProbeFailureCount_ += 1;
            if (monitorPowerProbeFailureCount_ >= 2)
            {
                reason = "physical monitor power state is unreachable after previously responding";
                return false;
            }
        }

        return true;
    }

    const std::vector<uint8_t>& blankFrame(const std::string& reason)
    {
        std::fill(rgb_.begin(), rgb_.end(), 0);
        previousRgb_ = rgb_;
        hasPreviousRgb_ = true;
        displayActive_ = false;
        displayStatusReason_ = reason;
        contentBoundsHoldFrames_ = 0;
        lastContentBounds_ = ContentBounds{};
        return rgb_;
    }

    void resetDeviceResources()
    {
        releaseDeviceResources();
        refreshOutputSelection();
        initializeDevice();
    }

    void initializeDevice()
    {
        const D3D_FEATURE_LEVEL levels[] = {
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
            D3D_FEATURE_LEVEL_10_1,
            D3D_FEATURE_LEVEL_10_0,
        };

        releaseDuplicationResources();

        if (!device_)
        {
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
                throw std::runtime_error("D3D11CreateDevice failed: " + describeHresult(hr));
            }
        }

        HRESULT duplicateHr = S_OK;
        const int maxAttempts = 20;
        for (int attempt = 1; attempt <= maxAttempts; ++attempt)
        {
            HRESULT hr = selection_.output->QueryInterface(__uuidof(IDXGIOutput1), reinterpret_cast<void**>(&output1_));
            if (FAILED(hr))
            {
                throw std::runtime_error("IDXGIOutput1 QueryInterface failed: " + describeHresult(hr));
            }

            duplicateHr = output1_->DuplicateOutput(device_, &duplication_);
            releaseCom(output1_);
            if (SUCCEEDED(duplicateHr))
            {
                return;
            }

            releaseCom(duplication_);
            if (!shouldRetryDuplicateOutput(duplicateHr) || attempt >= maxAttempts)
            {
                break;
            }

            std::cerr << "DuplicateOutput retry attempt=" << attempt
                      << " reason=" << describeHresult(duplicateHr) << std::endl;
            std::this_thread::sleep_for(std::chrono::milliseconds(std::min(1000, 100 * attempt)));
        }

        throw std::runtime_error("DuplicateOutput failed: " + describeHresult(duplicateHr));
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
            (!isMostlyBlack(leftContent) || !isMostlyBlack(rightContent));
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
        const int centerY = clampInt(y, 0, physicalHeight_ - 1);
        const int sourceTop = clampInt(centerY - averageRadiusY_, 0, physicalHeight_ - 1);
        const int sourceBottom = clampInt(centerY + averageRadiusY_ + 1, sourceTop + 1, physicalHeight_);
        const int sourceHeight = sourceBottom - sourceTop;
        ID3D11Texture2D* staging = ensureStaging(y <= physicalHeight_ / 2 ? TopLine : BottomLine, sourceWidth, sourceHeight);
        D3D11_BOX box{};
        box.left = static_cast<UINT>(sourceLeft);
        box.top = static_cast<UINT>(sourceTop);
        box.front = 0;
        box.right = static_cast<UINT>(sourceRight);
        box.bottom = static_cast<UINT>(sourceBottom);
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
            readAveragePixel(
                data,
                mapped.RowPitch,
                clampInt(sourceX - averageRadiusX_, 0, sourceWidth - 1),
                clampInt(sourceX + averageRadiusX_ + 1, sourceX + 1, sourceWidth),
                0,
                sourceHeight,
                &line[col * 3]);
        }
        context_->Unmap(staging, 0);
        return line;
    }

    std::vector<uint8_t> readVerticalLine(ID3D11Texture2D* frame, int x, StagingSlot slot)
    {
        const int centerX = clampInt(x, 0, physicalWidth_ - 1);
        const int sourceLeft = clampInt(centerX - averageRadiusX_, 0, physicalWidth_ - 1);
        const int sourceRight = clampInt(centerX + averageRadiusX_ + 1, sourceLeft + 1, physicalWidth_);
        const int sourceWidth = sourceRight - sourceLeft;
        ID3D11Texture2D* staging = ensureStaging(slot, sourceWidth, physicalHeight_);
        D3D11_BOX box{};
        box.left = static_cast<UINT>(sourceLeft);
        box.top = 0;
        box.front = 0;
        box.right = static_cast<UINT>(sourceRight);
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
            readAveragePixel(
                data,
                mapped.RowPitch,
                0,
                sourceWidth,
                clampInt(sourceY - averageRadiusY_, 0, physicalHeight_ - 1),
                clampInt(sourceY + averageRadiusY_ + 1, sourceY + 1, physicalHeight_),
                &line[row * 3]);
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

    void readAveragePixel(const uint8_t* data, UINT rowPitch, int left, int right, int top, int bottom, uint8_t* output) const
    {
        int red = 0;
        int green = 0;
        int blue = 0;
        int samples = 0;
        uint8_t pixelRgb[3]{};
        const int stride = pixelStride();

        for (int row = top; row < bottom; ++row)
        {
            const uint8_t* rowData = data + static_cast<size_t>(row) * rowPitch;
            for (int col = left; col < right; ++col)
            {
                readPixel(rowData + static_cast<size_t>(col) * stride, pixelRgb);
                red += pixelRgb[0];
                green += pixelRgb[1];
                blue += pixelRgb[2];
                samples += 1;
            }
        }

        if (samples <= 0)
        {
            output[0] = 0;
            output[1] = 0;
            output[2] = 0;
            return;
        }

        output[0] = static_cast<uint8_t>((red + samples / 2) / samples);
        output[1] = static_cast<uint8_t>((green + samples / 2) / samples);
        output[2] = static_cast<uint8_t>((blue + samples / 2) / samples);
    }

    void smoothFrame()
    {
        if (!hasPreviousRgb_)
        {
            previousRgb_ = rgb_;
            hasPreviousRgb_ = true;
            return;
        }

        const int currentWeight = options_.smoothingAlphaPercent;
        const int previousWeight = 100 - currentWeight;
        for (size_t index = 0; index + 2 < rgb_.size(); index += 3)
        {
            const int redDelta = std::abs(static_cast<int>(rgb_[index]) - static_cast<int>(previousRgb_[index]));
            const int greenDelta = std::abs(static_cast<int>(rgb_[index + 1]) - static_cast<int>(previousRgb_[index + 1]));
            const int blueDelta = std::abs(static_cast<int>(rgb_[index + 2]) - static_cast<int>(previousRgb_[index + 2]));
            if (redDelta + greenDelta + blueDelta <= options_.deadband)
            {
                rgb_[index] = previousRgb_[index];
                rgb_[index + 1] = previousRgb_[index + 1];
                rgb_[index + 2] = previousRgb_[index + 2];
                continue;
            }

            rgb_[index] = static_cast<uint8_t>((previousRgb_[index] * previousWeight + rgb_[index] * currentWeight + 50) / 100);
            rgb_[index + 1] = static_cast<uint8_t>((previousRgb_[index + 1] * previousWeight + rgb_[index + 1] * currentWeight + 50) / 100);
            rgb_[index + 2] = static_cast<uint8_t>((previousRgb_[index + 2] * previousWeight + rgb_[index + 2] * currentWeight + 50) / 100);
        }

        previousRgb_ = rgb_;
    }

    static uint16_t readLe16(const uint8_t* pixel)
    {
        return static_cast<uint16_t>(pixel[0]) | (static_cast<uint16_t>(pixel[1]) << 8);
    }

    static uint32_t readLe32(const uint8_t* pixel)
    {
        return static_cast<uint32_t>(pixel[0]) |
            (static_cast<uint32_t>(pixel[1]) << 8) |
            (static_cast<uint32_t>(pixel[2]) << 16) |
            (static_cast<uint32_t>(pixel[3]) << 24);
    }

    static uint8_t unorm10ToByte(uint32_t value)
    {
        return static_cast<uint8_t>((value * 255 + 511) / 1023);
    }

    static uint8_t unorm16ToByte(uint16_t value)
    {
        return static_cast<uint8_t>((static_cast<uint32_t>(value) * 255 + 32767) / 65535);
    }

    static float halfToFloat(uint16_t value)
    {
        const int sign = (value & 0x8000) ? -1 : 1;
        const int exponent = (value >> 10) & 0x1F;
        const int mantissa = value & 0x03FF;

        if (exponent == 0)
        {
            if (mantissa == 0)
            {
                return sign < 0 ? -0.0f : 0.0f;
            }
            return sign * std::ldexp(static_cast<float>(mantissa) / 1024.0f, -14);
        }

        if (exponent == 31)
        {
            return sign < 0 ? -1.0f : 1.0f;
        }

        return sign * std::ldexp(1.0f + static_cast<float>(mantissa) / 1024.0f, exponent - 15);
    }

    static uint8_t linearToSrgbByte(float value)
    {
        const float clamped = std::max(0.0f, std::min(1.0f, value));
        const float encoded = clamped <= 0.0031308f
            ? clamped * 12.92f
            : 1.055f * std::pow(clamped, 1.0f / 2.4f) - 0.055f;
        return static_cast<uint8_t>(std::round(std::max(0.0f, std::min(1.0f, encoded)) * 255.0f));
    }

    int pixelStride() const
    {
        switch (format_)
        {
        case DXGI_FORMAT_R16G16B16A16_FLOAT:
        case DXGI_FORMAT_R16G16B16A16_UNORM:
            return 8;
        default:
            return 4;
        }
    }

    void ensureSupportedFormat() const
    {
        switch (format_)
        {
        case DXGI_FORMAT_B8G8R8A8_UNORM:
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
        case DXGI_FORMAT_B8G8R8X8_UNORM:
        case DXGI_FORMAT_B8G8R8X8_UNORM_SRGB:
        case DXGI_FORMAT_R8G8B8A8_UNORM:
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
        case DXGI_FORMAT_R10G10B10A2_UNORM:
        case DXGI_FORMAT_R16G16B16A16_FLOAT:
        case DXGI_FORMAT_R16G16B16A16_UNORM:
            return;
        default:
            throw std::runtime_error("Unsupported DXGI frame format: " + std::to_string(static_cast<int>(format_)));
        }
    }

    void readPixel(const uint8_t* pixel, uint8_t* output) const
    {
        switch (format_)
        {
        case DXGI_FORMAT_R8G8B8A8_UNORM:
        case DXGI_FORMAT_R8G8B8A8_UNORM_SRGB:
            output[0] = pixel[0];
            output[1] = pixel[1];
            output[2] = pixel[2];
            return;
        case DXGI_FORMAT_B8G8R8A8_UNORM:
        case DXGI_FORMAT_B8G8R8A8_UNORM_SRGB:
        case DXGI_FORMAT_B8G8R8X8_UNORM:
        case DXGI_FORMAT_B8G8R8X8_UNORM_SRGB:
            output[0] = pixel[2];
            output[1] = pixel[1];
            output[2] = pixel[0];
            return;
        case DXGI_FORMAT_R10G10B10A2_UNORM:
        {
            const uint32_t packed = readLe32(pixel);
            output[0] = unorm10ToByte(packed & 0x3FF);
            output[1] = unorm10ToByte((packed >> 10) & 0x3FF);
            output[2] = unorm10ToByte((packed >> 20) & 0x3FF);
            return;
        }
        case DXGI_FORMAT_R16G16B16A16_UNORM:
            output[0] = unorm16ToByte(readLe16(pixel));
            output[1] = unorm16ToByte(readLe16(pixel + 2));
            output[2] = unorm16ToByte(readLe16(pixel + 4));
            return;
        case DXGI_FORMAT_R16G16B16A16_FLOAT:
            output[0] = linearToSrgbByte(halfToFloat(readLe16(pixel)));
            output[1] = linearToSrgbByte(halfToFloat(readLe16(pixel + 2)));
            output[2] = linearToSrgbByte(halfToFloat(readLe16(pixel + 4)));
            return;
        default:
            throw std::runtime_error("Unsupported DXGI frame format: " + std::to_string(static_cast<int>(format_)));
        }
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
                  << ",\"physicalHeight\":" << sampler.physicalHeight()
                  << ",\"averageRadiusPx\":" << sampler.averageRadiusPx()
                  << ",\"smoothingAlphaPercent\":" << sampler.smoothingAlphaPercent()
                  << ",\"deadband\":" << sampler.deadband()
                  << "}" << std::endl;

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
                      << ",\"format\":" << static_cast<int>(sampler.format())
                      << ",\"averageRadiusPx\":" << sampler.averageRadiusPx()
                      << ",\"smoothingAlphaPercent\":" << sampler.smoothingAlphaPercent()
                      << ",\"deadband\":" << sampler.deadband()
                      << ",\"displayActive\":" << (sampler.displayActive() ? "true" : "false")
                      << ",\"displayStatusReason\":\"" << escapeJson(sampler.displayStatusReason()) << "\""
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
