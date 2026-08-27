import Foundation

struct SolveJob: Identifiable, Decodable, Hashable {
    let id: UUID
    let sessionId: UUID
    let mode: String
    let status: String
    let progressPhase: String
    let error: String?
    let resultSummary: String
    let createdAt: Date
    let startedAt: Date?
    let finishedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case mode
        case status
        case progressPhase = "progress_phase"
        case error
        case resultSummary = "result_summary"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case finishedAt = "finished_at"
    }
}

struct SolveJobEvent: Identifiable, Decodable, Hashable {
    let id: UUID
    let jobId: UUID
    let level: String
    let phase: String
    let message: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case jobId = "job_id"
        case level
        case phase
        case message
        case createdAt = "created_at"
    }
}

struct CouncilReport: Identifiable, Decodable, Hashable {
    let id: UUID
    let jobId: UUID
    let winner: String?
    let synthesis: String
    let markdown: String
    let createdAt: Date

    enum CodingKeys: String, CodingKey {
        case id
        case jobId = "job_id"
        case winner
        case synthesis
        case markdown
        case createdAt = "created_at"
    }
}
