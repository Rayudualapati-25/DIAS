package org.dias.mobile.data

import java.net.URI

object HostAddress {
    fun normalize(input: String, allowLocalHttp: Boolean): String {
        val uri = try { URI(input.trim().trimEnd('/')) } catch (_: Exception) {
            throw IllegalArgumentException("Enter a valid host URL")
        }
        require(uri.host != null && uri.rawUserInfo == null && uri.rawQuery == null
            && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/")) {
            "Use the host URL only, without /api, credentials or query parameters"
        }
        val localHttp = allowLocalHttp && uri.scheme == "http"
            && uri.host in setOf("10.0.2.2", "127.0.0.1", "localhost")
        require(uri.scheme == "https" || localHttp) {
            "Use HTTPS, or a local emulator/USB address in the debug app"
        }
        require(uri.port == -1 || uri.port in 1..65535) { "Invalid port" }
        return URI(uri.scheme, null, uri.host.lowercase(), uri.port, null, null, null).toString()
    }
}
