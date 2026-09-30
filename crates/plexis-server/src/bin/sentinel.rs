#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    plexis_server::cli::run_cli().await
}
