import SwiftUI

@MainActor
final class JobDetailModel: ObservableObject {
    @Published var events: [SolveJobEvent] = []
    @Published var report: CouncilReport?
    @Published var error: String?

    private let client = SupabaseHistoryClient()

    func load(jobId: UUID) async {
        do {
            async let events = client.events(jobId: jobId)
            async let report = client.report(jobId: jobId)
            self.events = try await events
            self.report = try await report
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct JobDetailView: View {
    let job: SolveJob
    @StateObject private var model = JobDetailModel()

    var body: some View {
        List {
            Section("Status") {
                LabeledContent("State", value: job.status)
                LabeledContent("Phase", value: job.progressPhase)
                if let error = job.error {
                    Text(error).foregroundStyle(.red)
                }
            }

            if let report = model.report {
                Section("Answer") {
                    Text(report.synthesis)
                        .textSelection(.enabled)
                }
            }

            Section("Events") {
                ForEach(model.events) { event in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(event.message)
                        Text("\(event.level) / \(event.phase)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }

            if let error = model.error {
                Section("Error") {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(job.status.capitalized)
        .task {
            await model.load(jobId: job.id)
        }
    }
}
