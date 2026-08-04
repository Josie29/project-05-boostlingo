using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;

namespace Boostlingo.Backend.Tests;

public class CascadeAudioSessionTests
{
    /// <summary>
    /// Confirms the frontend's session.start handshake actually reaches the pipeline
    /// stub and gets a session.ready ack back with the PCM format it must send audio
    /// in - without this, later STT/MT/TTS stages have no config to key off of.
    /// </summary>
    [Fact]
    public async Task SessionStart_ReachesPipeline_AndReceivesSessionReady()
    {
        var fakePipeline = new FakeCascadePipeline();
        using var factory = new CascadeTestFactory(fakePipeline);
        using var socket = await ConnectAsync(factory.Server);

        await SendTextAsync(socket, """{"v":1,"type":"session.start","payload":{"sourceLang":"en","targetLang":"es"}}""");
        var envelope = await ReceiveEnvelopeAsync(socket);

        Assert.Equal("session.ready", envelope.RootElement.GetProperty("type").GetString());
        var payload = envelope.RootElement.GetProperty("payload");
        Assert.Equal(CascadeAudioFormat.SampleRateHz, payload.GetProperty("sampleRateHz").GetInt32());
        Assert.Equal(CascadeAudioFormat.Encoding, payload.GetProperty("encoding").GetString());
        Assert.Equal(CascadeAudioFormat.Channels, payload.GetProperty("channels").GetInt32());

        Assert.Equal("en", fakePipeline.StartedConfig?.SourceLang);
        Assert.Equal("es", fakePipeline.StartedConfig?.TargetLang);

        await CloseAsync(socket);
    }

    /// <summary>
    /// Confirms a binary PCM frame sent over the socket actually reaches the pipeline
    /// hook (not just gets accepted by the transport) - this is the seam #5-7 build on.
    /// </summary>
    [Fact]
    public async Task BinaryAudioFrame_ReachesPipelineStub()
    {
        var fakePipeline = new FakeCascadePipeline();
        using var factory = new CascadeTestFactory(fakePipeline);
        using var socket = await ConnectAsync(factory.Server);

        var chunk = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8 };
        await socket.SendAsync(chunk, WebSocketMessageType.Binary, endOfMessage: true, CancellationToken.None);

        var received = await fakePipeline.AudioChunks.Reader.ReadAsync(TestTimeout());
        Assert.Equal(chunk, received);

        await CloseAsync(socket);
    }

    /// <summary>
    /// Confirms an unparseable control frame gets a JSON error event back instead of
    /// silently dropping the message or tearing down the whole connection.
    /// </summary>
    [Fact]
    public async Task MalformedControlMessage_ReceivesErrorEvent_AndConnectionStaysOpen()
    {
        var fakePipeline = new FakeCascadePipeline();
        using var factory = new CascadeTestFactory(fakePipeline);
        using var socket = await ConnectAsync(factory.Server);

        await SendTextAsync(socket, "not json at all");
        var envelope = await ReceiveEnvelopeAsync(socket);

        Assert.Equal("error", envelope.RootElement.GetProperty("type").GetString());
        Assert.Equal(WebSocketState.Open, socket.State);

        await CloseAsync(socket);
    }

    /// <summary>
    /// Confirms session.stop notifies the pipeline exactly once and the server closes
    /// its side of the socket, so no session or buffer is left dangling after a
    /// graceful client-initiated stop.
    /// </summary>
    [Fact]
    public async Task SessionStop_NotifiesPipelineOnce_AndServerClosesSocket()
    {
        var fakePipeline = new FakeCascadePipeline();
        using var factory = new CascadeTestFactory(fakePipeline);
        using var socket = await ConnectAsync(factory.Server);

        await SendTextAsync(socket, """{"v":1,"type":"session.stop"}""");

        var buffer = new byte[4096];
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, TestTimeout());
        } while (result.MessageType != WebSocketMessageType.Close);

        await fakePipeline.EndedSignal.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, fakePipeline.SessionEndedCount);
    }

    /// <summary>
    /// Confirms an abrupt client disconnect (no session.stop) still tears the session
    /// down cleanly - the pipeline still gets its one OnSessionEndedAsync call, proving
    /// no session/buffer is leaked when the browser tab just closes.
    /// </summary>
    [Fact]
    public async Task AbruptDisconnect_StillNotifiesPipelineOfSessionEnd()
    {
        var fakePipeline = new FakeCascadePipeline();
        using var factory = new CascadeTestFactory(fakePipeline);
        var socket = await ConnectAsync(factory.Server);

        await SendTextAsync(socket, """{"v":1,"type":"session.start","payload":{"sourceLang":"en","targetLang":"es"}}""");
        await ReceiveEnvelopeAsync(socket);

        socket.Abort();
        socket.Dispose();

        await fakePipeline.EndedSignal.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(1, fakePipeline.SessionEndedCount);
    }

    private static CancellationToken TestTimeout() => new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token;

    private static async Task<WebSocket> ConnectAsync(TestServer server)
    {
        var client = server.CreateWebSocketClient();
        var uri = new Uri(server.BaseAddress, CascadeAudioEndpoints.RoutePattern);
        return await client.ConnectAsync(uri, TestTimeout());
    }

    private static async Task SendTextAsync(WebSocket socket, string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, TestTimeout());
    }

    private static async Task<JsonDocument> ReceiveEnvelopeAsync(WebSocket socket)
    {
        var buffer = new byte[8192];
        using var stream = new MemoryStream();
        WebSocketReceiveResult result;
        do
        {
            result = await socket.ReceiveAsync(buffer, TestTimeout());
            stream.Write(buffer, 0, result.Count);
        } while (!result.EndOfMessage);

        stream.Position = 0;
        return await JsonDocument.ParseAsync(stream);
    }

    private static async Task CloseAsync(WebSocket socket)
    {
        if (socket.State == WebSocketState.Open)
        {
            await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, "test done", TestTimeout());
        }
    }
}

/// <summary>
/// Records every call the transport makes so tests can assert the pipeline seam is
/// actually exercised, without needing a real STT/MT/TTS implementation.
/// </summary>
file sealed class FakeCascadePipeline : ICascadePipeline
{
    public Channel<byte[]> AudioChunks { get; } = Channel.CreateUnbounded<byte[]>();

    public CascadeSessionConfig? StartedConfig { get; private set; }

    public int SessionEndedCount { get; private set; }

    public TaskCompletionSource EndedSignal { get; } = new();

    public Task OnSessionStartedAsync(CascadeSessionConfig config, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        StartedConfig = config;
        return Task.CompletedTask;
    }

    public Task OnAudioChunkAsync(ReadOnlyMemory<byte> pcm, ICascadeEventSink events, CancellationToken cancellationToken)
    {
        AudioChunks.Writer.TryWrite(pcm.ToArray());
        return Task.CompletedTask;
    }

    public Task OnSessionEndedAsync(ICascadeEventSink events, CancellationToken cancellationToken)
    {
        SessionEndedCount++;
        EndedSignal.TrySetResult();
        return Task.CompletedTask;
    }
}

/// <summary>A <see cref="WebApplicationFactory{TEntryPoint}"/> that swaps in a fake pipeline.</summary>
file sealed class CascadeTestFactory(ICascadePipeline fakePipeline) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.ConfigureServices(services =>
        {
            services.AddSingleton(fakePipeline);
        });
    }
}
