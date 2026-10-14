package org.dias.mobile.screen

import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/** A scripted DIAS host on the device's own loopback. */
class FakeHost : Closeable {
    data class Call(val method: String, val target: String, val authorization: String?, val body: String) {
        val path: String get() = target.substringBefore('?')
    }
    data class Reply(val status: Int, val body: String)

    private val server = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    private val routes = ConcurrentHashMap<String, (Call) -> Reply>()
    private val received = CopyOnWriteArrayList<Call>()

    val baseUrl: String get() = "http://127.0.0.1:${server.localPort}"
    val calls: List<Call> get() = received.toList()

    init { thread(isDaemon = true, name = "fake-dias-host") { serve() } }

    fun on(method: String, path: String, reply: (Call) -> Reply) { routes["$method $path"] = reply }
    fun calls(method: String, path: String): List<Call> = calls.filter { it.method == method && it.path == path }

    /** A sign-in that answers every username with the same enrolled identity. */
    fun signsInAs(username: String, org: String, role: String) = on("POST", "/api/auth/login") {
        success(JSONObject().put("token", TOKEN).put("user",
            JSONObject().put("username", username).put("org", org).put("role", role)))
    }

    private fun serve() {
        while (!server.isClosed) {
            val socket = try { server.accept() } catch (_: SocketException) { return }
            thread(isDaemon = true) { socket.use(::answer) }
        }
    }

    private fun answer(socket: Socket) {
        val input = BufferedInputStream(socket.getInputStream())
        val requestLine = input.line()?.split(' ') ?: return
        if (requestLine.size < 2) return
        var length = 0
        var authorization: String? = null
        while (true) {
            val header = input.line()
            if (header.isNullOrEmpty()) break
            val value = header.substringAfter(':').trim()
            when (header.substringBefore(':').trim().lowercase()) {
                "content-length" -> length = value.toInt()
                "authorization" -> authorization = value
            }
        }
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val count = input.read(body, read, length - read)
            if (count < 0) break
            read += count
        }
        val call = Call(requestLine[0], requestLine[1], authorization, String(body, 0, read, Charsets.UTF_8))
        received.add(call)
        val reply = routes["${call.method} ${call.path}"]?.invoke(call) ?: failure(404, "no such route")
        if (reply === DROPPED) return
        val payload = reply.body.toByteArray(Charsets.UTF_8)
        socket.getOutputStream().apply {
            write(("HTTP/1.1 ${reply.status} Scripted\r\nContent-Type: application/json\r\n" +
                "Content-Length: ${payload.size}\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII))
            write(payload)
            flush()
        }
    }

    private fun InputStream.line(): String? {
        val text = StringBuilder()
        while (true) {
            val byte = read()
            if (byte < 0) return if (text.isEmpty()) null else text.toString()
            if (byte == '\n'.code) return text.toString().trimEnd('\r')
            text.append(byte.toChar())
        }
    }

    override fun close() = server.close()

    companion object {
        /** The host received the request and the connection was lost before any reply. */
        val DROPPED = Reply(-1, "")
        const val TOKEN = "scripted-token"
        const val BEARER = "Bearer $TOKEN"

        /** The host's response envelope. */
        fun success(data: Any?, status: Int = 200) = Reply(status,
            JSONObject().put("success", true).put("data", data ?: JSONObject.NULL)
                .put("error", JSONObject.NULL).toString())
        fun failure(status: Int, error: String) = Reply(status,
            JSONObject().put("success", false).put("data", JSONObject.NULL).put("error", error).toString())
        fun entries(vararg items: JSONObject) = JSONObject().put("entries", JSONArray(items.toList()))
            .put("storage", "fabric-ledger")
    }
}
