
// Appended only to an isolated checkout of the released Worker for the IPC smoke
// test. Production config validation continues to require HTTPS. This fixture
// constructs synthetic loopback configuration, then runs the production loop.
#[tokio::test]
#[ignore]
async fn serve_recovery_fixture() {
    let path = PathBuf::from(std::env::var("CYBION_SMOKE_WORKER_CONFIG").unwrap());
    let config: WorkerConfig = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert!(config.controller_url.starts_with("http://127.0.0.1:"));
    assert_eq!(config.access_token, "fixture");
    let _lock = setup::lock(&path).unwrap();
    run(config, &path).await.unwrap();
}
