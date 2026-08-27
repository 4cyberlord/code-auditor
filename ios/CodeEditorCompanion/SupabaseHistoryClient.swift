import Foundation

final class SupabaseHistoryClient {
    private let decoder: JSONDecoder

    init() {
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let value = try decoder.singleValueContainer().decode(String.self)
            if let date = Self.fractionalFormatter.date(from: value) {
                return date
            }
            if let date = Self.plainFormatter.date(from: value) {
                return date
            }
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Invalid date: \(value)")
            )
        }
    }

    private static let fractionalFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plainFormatter = ISO8601DateFormatter()

    func jobs() async throws -> [SolveJob] {
        try await get(
            "solve_jobs?select=*&order=created_at.desc&limit=50"
        )
    }

    func events(jobId: UUID) async throws -> [SolveJobEvent] {
        try await get(
            "solve_job_events?select=*&job_id=eq.\(jobId.uuidString)&order=created_at.asc&limit=200"
        )
    }

    func report(jobId: UUID) async throws -> CouncilReport? {
        let rows: [CouncilReport] = try await get(
            "council_reports?select=*&job_id=eq.\(jobId.uuidString)&limit=1"
        )
        return rows.first
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let base = AppConfig.supabaseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard let url = URL(string: "\(base)/rest/v1/\(path)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.setValue(AppConfig.supabaseAnonKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(AppConfig.supabaseAnonKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try decoder.decode(T.self, from: data)
    }
}
