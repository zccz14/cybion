mod cloud;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    cloud::serve().await
}
